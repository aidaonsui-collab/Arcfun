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
  fetchArcV4InstantPoolToken,
  getArcLivePriceUsdc,
  getArcPoolLiquidityUsdc,
  healIndexedSpotUsdc,
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

function cdnCache(sMaxAge: number, swr: number) {
  const v = `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`
  return { 'Cache-Control': v, 'CDN-Cache-Control': v, 'Vercel-CDN-Cache-Control': v }
}

// Something polls a handful of tokens every 20-36s around the clock (~4.3k calls a day each).
// At s-maxage=5 every poll missed. 30s lets most polls — and every viewer of the same token —
// share one function run; the page's own tape still updates every 4s once a token trades.
const TOKEN_API_CACHE = cdnCache(30, 60)
// Liquidity and burned% (?full=1) move slowly.
const TOKEN_STATS_CACHE = cdnCache(60, 120)
// Hidden and unknown tokens get polled too. Short enough that a just-launched token shows up.
const NOT_FOUND_CACHE = cdnCache(60, 60)

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
  if (pool.dexVenue === 'v4' || pool.instantMeta?.poolId) {
    const live = await withTimeout(fetchArcV4InstantPoolToken(token), SLOT0_MS)
    if (live && live.currentPrice > 0) {
      return {
        ...pool,
        currentPrice: live.currentPrice,
        marketCap: arcMarketCapUsd(live.currentPrice),
      }
    }
  }
  try {
    const { getVolume } = await import('@/lib/arc-indexer/store')
    const vol = await getVolume(token)
    const lastPrice = healIndexedSpotUsdc(lastSparkClose(vol))
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
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: NOT_FOUND_CACHE })
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
      if (!pool) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NOT_FOUND_CACHE })
      try {
        const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
        ;[pool] = await enrichTokensWithIndexVolume([pool])
      } catch {
        /* indexer optional */
      }
    }
    pool = await overlayLivePrice(pool, addr)
    if (full) pool = await overlayPoolStats(pool, addr)
    return jsonSafe(pool, { headers: full ? TOKEN_STATS_CACHE : TOKEN_API_CACHE })
  } catch (e) {
    console.error('[api/arc/token]', summarizeRpcError(e))
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }
}
