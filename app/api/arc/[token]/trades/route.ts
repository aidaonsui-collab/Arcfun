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
  // Widened from s-maxage=5 2026-08-30 alongside the fetchArcTrades sync coalescing (same file's
  // SYNC_FRESH_MS is 6s) — no point caching the edge response shorter than the underlying data
  // itself refuses to re-sync. Note ?fresh=1 only ever bypassed the CDN layer below, not
  // fetchArcTrades's own per-page or per-token freshness windows — `fresh` was never threaded
  // into that call. No current caller passes it; if one is added expecting a true bypass, it
  // needs to reach fetchArcTrades too.
  return NextResponse.json(data.trades.length || offset ? data : EMPTY, {
    headers: {
      'Cache-Control': fresh
        ? 'private, no-store'
        : 'public, s-maxage=8, stale-while-revalidate=20',
    },
  })
}
