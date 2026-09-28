/**
 * GET /api/arc/vault — public, read-only snapshot for the Eve Vault board.
 * See lib/arc-vault.ts for what this is and, importantly, what it deliberately isn't yet
 * (no fee routing has been turned on — see that file's header comment).
 */
import { NextResponse } from 'next/server'
import { getVaultSnapshot } from '@/lib/arc-vault'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const snapshot = await getVaultSnapshot()
    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    console.error('[api/arc/vault]', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
