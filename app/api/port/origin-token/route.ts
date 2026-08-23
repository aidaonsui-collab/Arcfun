import { NextRequest, NextResponse } from 'next/server'
import { lookupOriginToken } from '@/lib/port/origin-token'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || ''
  const info = await lookupOriginToken(token)
  if (!info) {
    return NextResponse.json({ ok: false, error: 'not a live Instant or Reflection token' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, ...info })
}
