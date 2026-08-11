/**
 * GET /api/arc/indexer/run — Vercel Cron (or manual with CRON_SECRET).
 * Advances Arc event index: factories, OTC offers, swap catch-up + volume windows.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runArcIndexerCycle } from '@/lib/arc-indexer/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runArcIndexerCycle()
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (e) {
    console.error('[api/arc/indexer/run]', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
