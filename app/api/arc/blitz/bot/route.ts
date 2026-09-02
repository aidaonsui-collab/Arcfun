/**
 * GET|POST /api/arc/blitz/bot — Blitz launch is unwired. Cron removed from vercel.json.
 */
import { NextRequest, NextResponse } from 'next/server'
import { blitzLaunchEnabled } from '@/lib/arc-blitz'
import { runBlitzBotTick } from '@/lib/arc-blitz-bot'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function handle(req: NextRequest) {
  if (!blitzLaunchEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runBlitzBotTick()
    return NextResponse.json(result)
  } catch (e) {
    console.error('[blitz/bot]', e instanceof Error ? e.message : 'tick failed')
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

export const GET = handle
export const POST = handle
