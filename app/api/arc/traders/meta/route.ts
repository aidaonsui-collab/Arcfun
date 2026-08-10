/**
 * GET/POST /api/arc/traders/meta — batch wallet → avatar/handle (opt-in profiles only).
 *
 * GET  ?addrs=0x…,0x…
 * POST { "addresses": ["0x…"] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getTraderMetas, traderMetasToJson } from '@/lib/arc-trader-meta'

export const dynamic = 'force-dynamic'

function parseAddrs(req: NextRequest, body?: { addresses?: string[] }): string[] {
  if (body?.addresses?.length) return body.addresses
  const q = req.nextUrl.searchParams.get('addrs') || req.nextUrl.searchParams.get('addresses') || ''
  return q
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function GET(req: NextRequest) {
  try {
    const addrs = parseAddrs(req)
    const map = await getTraderMetas(addrs)
    return NextResponse.json(
      { ok: true, traders: traderMetasToJson(map) },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, traders: {} }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { addresses?: string[] }
    const addrs = parseAddrs(req, body)
    const map = await getTraderMetas(addrs)
    return NextResponse.json(
      { ok: true, traders: traderMetasToJson(map) },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, traders: {} }, { status: 500 })
  }
}
