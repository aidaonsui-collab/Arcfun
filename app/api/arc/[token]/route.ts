/**
 * GET /api/arc/[token] — Arc Instant or bonding-curve pool as PoolToken.
 */
import { NextResponse } from 'next/server'
import { type Address } from 'viem'
import { fetchArcPoolToken, getArcPoolLiquidityUsdc } from '@/lib/arc-instant-tokens'
import { fetchTokenBurnedPct } from '@/lib/evm-holders'
import { arcInstantEnabled, arcCurveEnabled } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

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
    let pool = await fetchArcPoolToken(token as Address)
    if (!pool) return NextResponse.json({ error: 'not found' }, { status: 404 })
    try {
      const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
      ;[pool] = await enrichTokensWithIndexVolume([pool])
    } catch {
      /* indexer optional */
    }
    const [liq, burnedPct] = await Promise.all([
      getArcPoolLiquidityUsdc(
        token as Address,
        pool.instantMeta?.uniPool as Address | undefined,
        pool.currentPrice,
      ).catch(() => null),
      fetchTokenBurnedPct(token as Address).catch(() => null),
    ])
    if (liq) {
      pool = { ...pool, liquidityUsd: liq.tvlUsd, liquidityQuoteUsd: liq.usdc }
    }
    if (burnedPct != null) {
      pool = { ...pool, burnedPct }
    }
    // Widened from s-maxage=8 2026-08-30: at current platform volume most tokens go longer than
    // 8s between viewers, so nearly every real visit was a CDN cache miss paying the route's own
    // RPC chain (pool + liquidity + burnedPct) live — measured ~5.3s cold. This pool/liquidity
    // data does not move meaningfully faster than that; syncTradesToHead's own SYNC_FRESH_MS
    // (lib/arc-trades.ts) uses the same order of magnitude for the trade tape.
    // CDN-Cache-Control / Vercel-CDN-Cache-Control: Vercel strips s-maxage from Cache-Control
    // on dynamic routes, so the catalog route stamps all three. Same pattern here (s-maxage=20,
    // swr=40 — live price/liq, tighter than the home catalog's swr=300).
    return jsonSafe(pool, {
      headers: {
        'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
        'CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
        'Vercel-CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
      },
    })
  } catch (e) {
    console.error('[api/arc/token]', summarizeRpcError(e))
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }
}
