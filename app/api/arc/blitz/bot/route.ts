/**
 * GET|POST /api/arc/blitz/bot — Vercel Cron every minute (see vercel.json).
 * Polls the bot account's X mentions (OAuth 1.0a user context) and Instant-creates
 * matching launch commands on Arc.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once
 * CRON_SECRET is set — https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runBlitzBotTick } from '@/lib/arc-blitz-bot'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function handle(req: NextRequest) {
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
