/**
 * GET /api/arc/[token] — PoolToken for the token page.
 *
 * Default: catalog KV row + optional Uni slot0 overlay (800ms cap). No factory scan.
 * `?full=1`: also liquidity + burned% (5s cap). The token page loads that once after
 * first paint so those tiles fill in without blocking the hero.
 */
import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import {
  arcMarketCapUsd,
  fetchArcPoolToken,
  getArcLivePriceUsdc,
  getArcPoolLiquidityUsdc,
} from '@/lib/arc-instant-tokens'
import { fetchTokenBurnedPct } from '@/lib/evm-holders'
import { getArcCatalogToken } from '@/lib/arc-catalog-cache'
import { lastSparkClose } from '@/lib/arc-catalog-from-index'
import { arcInstantEnabled, arcCurveEnabled } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken, type PoolToken } from '@/lib/tokens'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

const TOKEN_API_CACHE = {
  'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
  'CDN-Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
}

const SLOT0_MS = 800
const STATS_MS = 5_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(null)
      },
    )
  })
}

async function overlayLivePrice(pool: PoolToken, token: Address): Promise<PoolToken> {
  const uni = pool.instantMeta?.uniPool as Address | undefined
  if (uni) {
    const live = await withTimeout(getArcLivePriceUsdc(token, uni), SLOT0_MS)
    if (live != null && live > 0) {
      return {
        ...pool,
        currentPrice: live,
        marketCap: arcMarketCapUsd(live),
      }
    }
  }
  try {
    const { getVolume } = await import('@/lib/arc-indexer/store')
    const vol = await getVolume(token)
    const lastPrice = lastSparkClose(vol)
    if (lastPrice > 0) {
      return {
        ...pool,
        currentPrice: lastPrice,
        marketCap: arcMarketCapUsd(lastPrice),
      }
    }
  } catch {
    /* indexer optional — keep catalog/slot0 pool */
  }
  return pool
}

async function overlayPoolStats(pool: PoolToken, token: Address): Promise<PoolToken> {
  const uni = pool.instantMeta?.uniPool as Address | undefined
  const [liq, burnedPct] = await Promise.all([
    withTimeout(getArcPoolLiquidityUsdc(token, uni, pool.currentPrice), STATS_MS),
    withTimeout(fetchTokenBurnedPct(token), STATS_MS),
  ])
  let next = pool
  if (liq) {
    next = { ...next, liquidityUsd: liq.tvlUsd, liquidityQuoteUsd: liq.usdc }
  }
  if (burnedPct != null) {
    next = { ...next, burnedPct }
  }
  return next
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }
  if (isHiddenToken(token)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!arcInstantEnabled() && !arcCurveEnabled()) {
    return NextResponse.json({ error: 'arc launchpad not configured' }, { status: 404 })
  }
  const full = req.nextUrl.searchParams.get('full') === '1'
  try {
    const addr = token as Address
    let pool = await getArcCatalogToken(addr)
    if (!pool) {
      pool = await fetchArcPoolToken(addr)
      if (!pool) return NextResponse.json({ error: 'not found' }, { status: 404 })
      try {
        const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
        ;[pool] = await enrichTokensWithIndexVolume([pool])
      } catch {
        /* indexer optional */
      }
    }
    pool = await overlayLivePrice(pool, addr)
    if (full) pool = await overlayPoolStats(pool, addr)
    return jsonSafe(pool, { headers: TOKEN_API_CACHE })
  } catch (e) {
    console.error('[api/arc/token]', summarizeRpcError(e))
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }
}
