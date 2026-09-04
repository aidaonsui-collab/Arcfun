/**
 * GET /api/arc/indexer/otc — manual OTC book tick.
 * Live cadence is Jessica's Air (lib/arc-indexer/daemon.ts), not a Vercel minute cron.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runOtcIndexerCycle } from '@/lib/arc-indexer/otc-cycle'
import { robinOtcEnabled } from '@/lib/bridge/robin-otc'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!robinOtcEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const out = await runOtcIndexerCycle()
    if (!out.ok) {
      return NextResponse.json(out, { status: 404 })
    }
    return NextResponse.json(out)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
