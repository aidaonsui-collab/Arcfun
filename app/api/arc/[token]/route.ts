/**
 * GET /api/arc/[token] — PoolToken for the token page.
 *
 * Fast path: home-catalog KV row + optional Uni slot0 overlay (capped). No factory
 * scan, no liquidity, no burned%. Cold path (not in catalog yet) falls back to a
 * live factory lookup without the extra RPC legs. Liquidity/burned still show as
 * "—" until a later enrich; first byte should not wait on them (~5.3s measured).
 */
import { NextResponse } from 'next/server'
import { type Address } from 'viem'
import { arcMarketCapUsd, fetchArcPoolToken, getArcLivePriceUsdc } from '@/lib/arc-instant-tokens'
import { getArcCatalogToken } from '@/lib/arc-catalog-cache'
import { arcInstantEnabled, arcCurveEnabled } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken, type PoolToken } from '@/lib/tokens'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

const TOKEN_API_CACHE = {
  'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
  'CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
}

const SLOT0_MS = 800

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
  if (!uni) return pool
  const live = await withTimeout(getArcLivePriceUsdc(token, uni), SLOT0_MS)
  if (live == null || !(live > 0)) return pool
  return {
    ...pool,
    currentPrice: live,
    marketCap: arcMarketCapUsd(live),
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
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
  try {
    const addr = token as Address
    const cached = await getArcCatalogToken(addr)
    if (cached) {
      const pool = await overlayLivePrice(cached, addr)
      return jsonSafe(pool, { headers: TOKEN_API_CACHE })
    }

    let pool = await fetchArcPoolToken(addr)
    if (!pool) return NextResponse.json({ error: 'not found' }, { status: 404 })
    try {
      const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
      ;[pool] = await enrichTokensWithIndexVolume([pool])
    } catch {
      /* indexer optional */
    }
    pool = await overlayLivePrice(pool, addr)
    return jsonSafe(pool, { headers: TOKEN_API_CACHE })
  } catch (e) {
    console.error('[api/arc/token]', summarizeRpcError(e))
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }
}
