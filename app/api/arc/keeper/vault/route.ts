/**
 * GET /api/arc/keeper/vault — cron entry point for the Eve Vault treasury keeper.
 * See lib/arc-vault.ts's runVaultKeeperCycle for what this actually does today: balance
 * bookkeeping only, since fee routing hasn't been turned on and there's no approved RWA to buy.
 *
 * Auth: mutating path requires `Authorization: Bearer $CRON_SECRET`, same convention as the
 * other keeper routes. `?status=1` is a public, read-only bypass — no secrets, no on-chain
 * writes — so the board can show current state without needing the secret.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getVaultSnapshot, runVaultKeeperCycle } from '@/lib/arc-vault'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const snapshot = await getVaultSnapshot()
    return NextResponse.json({ ok: true, ...snapshot })
  }

  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runVaultKeeperCycle()
    return NextResponse.json(result)
  } catch (e) {
    console.error('[keeper/vault]', e)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
