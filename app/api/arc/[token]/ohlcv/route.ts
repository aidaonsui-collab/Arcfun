import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcPoolToken } from '@/lib/arc-instant-tokens'
import { buildCandles, fillCandleGaps } from '@/lib/candles'

export const dynamic = 'force-dynamic'

/** TradingView resolutions → bucket seconds. */
const RES_SEC: Record<string, number> = {
  '1': 60,
  '5': 300,
  '15': 900,
  '60': 3_600,
  '240': 14_400,
  '1D': 86_400,
  D: 86_400,
  '1W': 604_800,
}

type TvCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}



export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await params
  const token = (rawToken || '').trim()
  if (!isAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }
  const resolution = req.nextUrl.searchParams.get('resolution') || '15'
  const bucketSec = RES_SEC[resolution] ?? 900

  const tape = await fetchArcTrades(token as Address, { limit: 600 })
  let fallback = 0
  if (tape.trades.length === 0) {
    const pool = await fetchArcPoolToken(token as Address)
    fallback = pool?.currentPrice ?? 0
  } else {
    fallback = tape.trades[0]?.priceUsd ?? 0
  }

  const filled = fillCandleGaps(buildCandles(tape.trades, bucketSec, fallback), bucketSec)
  const candles: TvCandle[] = filled.map((c) => ({
    time: c.time * 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))

  return NextResponse.json(
    { candles, resolution },
    { headers: { 'Cache-Control': 's-maxage=15, stale-while-revalidate=30' } },
  )
}
