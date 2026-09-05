/**
 * GET /api/arc/keeper/eve-holder-rewards — cron entry point for the $EVE holder-rewards
 * experiment: collect the LP position's platform fee leg, swap it into $COOL, pro-rata disperse
 * to every current EVE holder. See lib/arc-eve-holder-rewards.ts for the full mechanics and
 * docs/EVE-HOLDER-REWARDS.md for the one-time manual setup this depends on. Triggered hourly from
 * Jessica's Air (com.eve.holder-rewards launchd job), not a Vercel cron — see PR #185.
 *
 * Auth: the mutating path requires `Authorization: Bearer $CRON_SECRET`. Reject anything else so
 * this can't be triggered/spammed by an outside caller (it spends real gas and moves real
 * reward-token balance on every accepted call).
 *
 * `?status=1` bypasses the cron-secret gate — read-only, no on-chain action, no secrets in the
 * response — so progress can be checked from a browser at any time. Add `&wallet=0x...` to also
 * get that address's cumulative $COOL received so far (used by the profile page's rewards tile).
 */
import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import {
  backfillCycle1Claimed,
  getClaimedCoolRewards,
  getEveHolderRewardsStatus,
  runEveHolderRewardsCycle,
} from '@/lib/arc-eve-holder-rewards'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const status = await getEveHolderRewardsStatus()
    const walletParam = req.nextUrl.searchParams.get('wallet')
    const walletClaimed =
      walletParam && isAddress(walletParam)
        ? (await getClaimedCoolRewards(walletParam as Address)).toString()
        : undefined
    return NextResponse.json({ ok: true, ...status, ...(walletClaimed != null ? { walletClaimed } : {}) })
  }

  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (req.nextUrl.searchParams.get('backfill')) {
    const result = await backfillCycle1Claimed()
    return NextResponse.json(result)
  }

  const pk = process.env.ARC_EVE_REWARDS_KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!pk) {
    return NextResponse.json({ ok: false, error: 'ARC_EVE_REWARDS_KEEPER_PRIVATE_KEY not set' }, { status: 500 })
  }

  try {
    const result = await runEveHolderRewardsCycle(pk)
    return NextResponse.json(result)
  } catch (e) {
    console.error('[keeper/eve-holder-rewards]', e)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
