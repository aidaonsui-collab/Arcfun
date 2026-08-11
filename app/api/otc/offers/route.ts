/**
 * GET /api/otc/offers — indexed OTC book (fast). Falls back to empty if index cold.
 * Client may still run live scan if this returns empty + no indexer.
 */
import { NextResponse } from 'next/server'
import { getIndexedOtcBook } from '@/lib/arc-indexer/run'
import { jsonSafe } from '@/lib/json-safe'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const offers = await getIndexedOtcBook()
    return jsonSafe(
      {
        ok: true,
        source: 'arc-indexer',
        at: Date.now(),
        offers,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } },
    )
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        offers: [],
      },
      { status: 500 },
    )
  }
}
