/**
 * GET /api/arc/token?id=0x… — display meta for Arc Instant tokens.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') || ''
  if (!isPlausibleEvmAddress(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  const meta = await getArcTokenMeta(id)
  return NextResponse.json({ ok: true, chain: 'arc', token: id.toLowerCase(), meta })
}
