/**
 * GET /api/arc/keeper/reflect — Vercel Cron hits this hourly (see vercel.json).
 * Collects Instant locker LP fees (MonLock 70/30 or CrucibleLock 50/25/10/10/5),
 * projectBurn()s accrued 10% USDC into the launch token to dead, then
 * Crucible.cook()s the sink's USDC into $EVE to dead. Then Instant Reflection
 * (collect → forward → reflect). See lib/arc-reflection-keeper.ts.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once CRON_SECRET is
 * set as a project env var — https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 * Reject anything else so this route can't be triggered/spammed by an outside caller (it spends
 * real gas from the keeper wallet on every accepted call).
 */
import { NextRequest, NextResponse } from 'next/server'
import { arcInstantEnabled, arcReflectionEnabled } from '@/lib/contracts-arc'
import { runReflectionKeeperCycle } from '@/lib/arc-reflection-keeper'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!arcReflectionEnabled() && !arcInstantEnabled()) {
    return NextResponse.json({ ok: false, error: 'no Instant or Reflection factory configured' }, { status: 404 })
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
