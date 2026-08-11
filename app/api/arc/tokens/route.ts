/**
 * GET /api/arc/tokens — Arc Instant + bonding-curve catalog for home grid.
 */
import { NextResponse } from 'next/server'
import { arcInstantEnabled, arcCurveEnabled } from '@/lib/contracts-arc'
import { buildArcCatalog } from '@/lib/arc-instant-tokens'
import { isHiddenToken } from '@/lib/tokens'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!arcInstantEnabled() && !arcCurveEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'arc launchpad not configured', tokens: [] },
      { status: 404 },
    )
  }
  try {
    let { tokens, source } = await buildArcCatalog()
    tokens = tokens.filter((t) => !isHiddenToken(t.coinType ?? t.poolId))
    // Overlay volume windows from Arc event indexer when available.
    try {
      const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
      tokens = await enrichTokensWithIndexVolume(tokens)
      source = `${source}+idx`
    } catch {
      /* indexer optional */
    }
    return jsonSafe(
      { ok: true, source, at: Date.now(), tokens },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  } catch (e) {
    console.error('[api/arc/tokens]', summarizeRpcError(e))
    return NextResponse.json(
      { ok: false, error: (e as Error).message, tokens: [] },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
