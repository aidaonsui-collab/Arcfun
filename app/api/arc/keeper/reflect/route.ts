/**
 * GET /api/arc/keeper/reflect — Vercel Cron hits this every 15 minutes (see vercel.json).
 * Sweeps LP fees to holders for every live Arc Instant Reflection token. See
 * lib/arc-reflection-keeper.ts for the actual per-token chain.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once CRON_SECRET is
 * set as a project env var — https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 * Reject anything else so this route can't be triggered/spammed by an outside caller (it spends
 * real gas from the keeper wallet on every accepted call).
 */
import { NextRequest, NextResponse } from 'next/server'
import { arcReflectionEnabled } from '@/lib/contracts-arc'
import { runReflectionKeeperCycle } from '@/lib/arc-reflection-keeper'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!arcReflectionEnabled()) {
    return NextResponse.json({ ok: false, error: 'reflection factory not configured' }, { status: 404 })
  }

  const pk = process.env.ARC_REFLECTION_KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!pk) {
    return NextResponse.json({ ok: false, error: 'ARC_REFLECTION_KEEPER_PRIVATE_KEY not set' }, { status: 500 })
  }

  try {
    const result = await runReflectionKeeperCycle(pk)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[keeper/reflect]', e)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
