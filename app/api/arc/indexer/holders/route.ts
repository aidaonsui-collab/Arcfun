/**
 * GET /api/arc/indexer/holders — Vercel Cron. Keeps every known token's holder ledger caught up
 * (see lib/evm-holders.ts's header for why this exists and how the ledger works).
 *
 * Deliberately its own cron, not folded into /api/arc/indexer/run alongside factories/swaps —
 * two reasons:
 *   1. One misbehaving phase (a slow token, a bad RPC stretch) shouldn't be able to starve the
 *      others of their share of a shared tick's time budget.
 *   2. This is new, unproven-at-scale work. Jessica's dedicated loop just had its own reliability
 *      gap fixed (the lease was expiring mid-cycle under exactly this kind of RPC-bound work —
 *      see lib/arc-indexer/daemon.ts). Adding a second, larger job to that same loop before it's
 *      run clean for a while would be compounding an unproven change on top of another one.
 * Worth revisiting once both have some runway: this cron and the factory/swap one are both
 * candidates for the same dedicated-loop-plus-lease treatment Jessica already gives the other.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runHoldersLedgerCycle } from '@/lib/evm-holders'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
