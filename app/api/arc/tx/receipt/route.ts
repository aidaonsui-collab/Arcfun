/**
 * GET /api/arc/tx/receipt?hash=0x… — wait for an Instant/Reflection create on Infura.
 * Browser public RPCs hang on receipts; the create form must not poll those.
 */
import { NextRequest, NextResponse } from 'next/server'
import { type Hex } from 'viem'
import { waitArcCreateReceipt } from '@/lib/arc-tx-receipt'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const HASH_RE = /^0x[0-9a-fA-F]{64}$/

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'arc-tx-receipt', 20, 60, true)
  if (limited) return limited

  const hash = (req.nextUrl.searchParams.get('hash') || '').trim()
  if (!HASH_RE.test(hash)) {
    return NextResponse.json({ ok: false, error: 'invalid hash' }, { status: 400 })
  }

  try {
    const created = await waitArcCreateReceipt(hash as Hex, 25_000)
    return NextResponse.json({
      ok: true,
      token: created.token,
      pool: created.pool || '',
      status: created.receipt.status,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'receipt wait failed'
    const status = /timed out|timeout/i.test(msg) ? 504 : 502
    return NextResponse.json({ ok: false, error: msg.slice(0, 180) }, { status })
  }
}
