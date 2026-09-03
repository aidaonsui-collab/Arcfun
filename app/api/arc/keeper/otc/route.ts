/**
 * GET /api/arc/keeper/otc — OTC desk unwired; cron removed from vercel.json.
 * Settles pending Instant OTC fills (Base/ARB/ETH → Arc) against the shared desk contracts. See
 * lib/arc-otc-keeper.ts for the actual per-fill lock → deliver → settle chain, and its top-of-file
 * comment for why ArcFun runs its own copy of this alongside Robinpad's.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically once CRON_SECRET is
 * set as a project env var — https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 * Reject anything else so this route can't be triggered/spammed by an outside caller (it spends
 * real gas from the keeper wallet, on three chains, on every accepted call).
 */
import { NextRequest, NextResponse } from 'next/server'
import { runOtcKeeperTick } from '@/lib/arc-otc-keeper'
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

  const dryRun = process.env.ARC_OTC_KEEPER_LIVE === '0'
  try {
    // Cap lookback at 9k — Base public RPC eth_getLogs limit is 10k; keeper chunks further.
    const out = await runOtcKeeperTick({ dryRun, lookbackBlocks: 9_000n })
    if (!out.ok) {
      console.error('[keeper/otc]', out.error)
      return NextResponse.json({ ...out, ok: false }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      mode: dryRun ? 'dry-run' : 'live',
      keeper: out.keeper,
      liquidity: out.liquidity,
      spokes: out.spokes,
      results: out.results,
    })
  } catch (e) {
    console.error('[keeper/otc]', e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
