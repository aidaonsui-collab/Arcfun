/**
 * GET /api/arc/[token]/trades — Uni V3 Swap tape for Arc Instant TOKEN/USDC pools.
 */
import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { fetchArcTrades } from '@/lib/arc-trades'
import { isPlausibleEvmAddress } from '@/lib/evm-address'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const EMPTY = {
  trades: [],
  stats: {
    txns: 0,
    buys: 0,
    sells: 0,
    volumeUsd: 0,
    buyVolUsd: 0,
    sellVolUsd: 0,
    traders: 0,
    buyers: 0,
    sellers: 0,
  },
  pricePoints: [],
  total: 0,
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }
  const fresh = req.nextUrl.searchParams.get('fresh') === '1'
  const limit = Number(req.nextUrl.searchParams.get('limit') || '') || undefined
  const offset = Number(req.nextUrl.searchParams.get('offset') || '') || undefined
  const data = await fetchArcTrades(token as Address, { limit, offset, fresh })
  const payload = data.trades.length || offset ? data : EMPTY
  const empty = !payload.trades.length && !offset
  // Empty tapes must not sit on the CDN — that is how a first view of a live token
  // stayed blank for 20s (or forever if the tab closed). Live pages poll ~4s; 4s
  // s-maxage keeps those as edge hits once the tape has rows.
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': fresh || empty
        ? 'private, no-store'
        : 'public, s-maxage=4, stale-while-revalidate=20',
    },
  })
}
