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
    return jsonSafe(pool, {
      headers: { 'Cache-Control': 'public, s-maxage=8, stale-while-revalidate=15' },
    })
  } catch (e) {
    console.error('[api/arc/token]', summarizeRpcError(e))
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }
}
