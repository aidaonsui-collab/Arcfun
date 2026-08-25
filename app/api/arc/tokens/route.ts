/**
 * GET /api/arc/tokens — Arc Instant + bonding-curve catalog for home grid.
 */
import { NextResponse } from 'next/server'
import { arcInstantEnabled, arcCurveEnabled } from '@/lib/contracts-arc'
import { CATALOG_CACHE_HEADERS, getArcHomeCatalog } from '@/lib/arc-catalog-cache'
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
    const { tokens, source, at } = await getArcHomeCatalog()
    return jsonSafe(
      { ok: true, source, at, tokens },
      {
        headers:
          tokens.length === 0
            ? { 'Cache-Control': 'no-store' }
            : CATALOG_CACHE_HEADERS,
      },
    )
  } catch (e) {
    console.error('[api/arc/tokens]', summarizeRpcError(e))
    return NextResponse.json(
      { ok: false, error: (e as Error).message, tokens: [] },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
