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
  const data = await fetchArcTrades(token as Address, { limit, offset })
  // Match the token-page poll (20s in TokenPageClient / tv-datafeed). An 8s CDN TTL with a
  // 20s poll still origin-hits every tick; 20s lets the edge absorb open-tab traffic.
  // ?fresh=1 only bypasses the CDN layer, not fetchArcTrades's own freshness windows.
  return NextResponse.json(data.trades.length || offset ? data : EMPTY, {
    headers: {
      'Cache-Control': fresh
        ? 'private, no-store'
        : 'public, s-maxage=20, stale-while-revalidate=60',
    },
  })
}
