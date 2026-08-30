/**
 * GET|POST /api/arc/telegram/launches — Vercel Cron every minute (see vercel.json).
 * Posts new Instant launches to Telegram. First empty-set tick seeds the
 * posted-address set so existing tokens are not dumped into the channel.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once
 * CRON_SECRET is set — https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runTelegramLaunchTick } from '@/lib/telegram-launches'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runTelegramLaunchTick()
    return NextResponse.json(result)
  } catch (e) {
    console.error('[telegram/launches]', e instanceof Error ? e.message : 'tick failed')
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

export const GET = handle
export const POST = handle
