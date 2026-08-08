/**
 * GET /api/arc/[token]/trades — Uni V3 Swap tape for Arc Instant TOKEN/USDC pools.
 */
import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { fetchArcTrades } from '@/lib/arc-trades'
import { isPlausibleEvmAddress } from '@/lib/evm-address'

export const dynamic = 'force-dynamic'

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
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }
  const fresh = req.nextUrl.searchParams.get('fresh') === '1'
  const data = await fetchArcTrades(token as Address)
  return NextResponse.json(data.trades.length ? data : EMPTY, {
    headers: {
      'Cache-Control': fresh
        ? 'private, no-store'
        : 'public, s-maxage=5, stale-while-revalidate=10',
    },
  })
}
