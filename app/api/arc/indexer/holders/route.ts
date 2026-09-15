/**
 * GET /api/arc/indexer/holders — Vercel Cron fallback. Keeps every known token's holder
 * ledger caught up (see lib/evm-holders.ts). Jessica's dedicated loop now runs the same
 * cycle on a 3-minute timer; this cron skips while that lease is live, same as
 * /api/arc/indexer/run. Fallback only: a 200s Fluid tick every 3 minutes was 24/7
 * provisioned-memory on Pro even when the Air was already doing the work.
 *
 * Still its own route, not folded into /api/arc/indexer/run. A slow holders batch
 * must not starve factory/swap catch-up of its 2-minute tick.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runHoldersLedgerCycle } from '@/lib/evm-holders'
import { isHoldersLeaseLive, readIndexerLease } from '@/lib/arc-indexer/lease'

export const dynamic = 'force-dynamic'
// batchSize(10) * perTokenBudgetMs(20s) below is a 200s worst case — matches the 300s ceiling
// /api/arc/indexer/run already uses for the same "many tokens, each potentially slow" shape.
// Confirmed live: the first-ever tick against a cold registry hit a hard Vercel timeout at 60s
// (an abrupt kill mid-batch, not this file's own graceful per-token budget deadline) before this
// fix. Safe either way — each token's progress persists via its own cursor+hset writes as it
// goes, so a kill mid-batch just leaves the remaining tokens for the next tick — but a hard kill
// wastes whatever budget the token being killed mid-scan had left, instead of returning cleanly.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const lease = await readIndexerLease()
  if (isHoldersLeaseLive(lease)) {
    return NextResponse.json({
      ok: true,
      skipped: 'dedicated-indexer',
      lease,
    })
  }

  try {
    const result = await runHoldersLedgerCycle({ batchSize: 10, perTokenBudgetMs: 20_000 })
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (e) {
    console.error('[api/arc/indexer/holders]', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
