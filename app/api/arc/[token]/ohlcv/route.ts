import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcPoolToken } from '@/lib/arc-instant-tokens'
import { buildCandles } from '@/lib/candles'
import type { EvmTrade } from '@/lib/evm-trades'

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

/** 1m / 5m / 15m: one bar per print so the path stays dense. Higher TFs stay real OHLC. */
const TICK_RES = new Set(['1', '5', '15'])

type TvCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function tickCandles(trades: EvmTrade[]): TvCandle[] {
  const priced = trades.filter((t) => t.ts > 0 && t.priceUsd > 0).sort((a, b) => a.ts - b.ts)
  return priced.map((t, i) => {
    const prev = i > 0 ? priced[i - 1].priceUsd : t.priceUsd
    return {
      time: t.ts * 1000,
      open: prev,
      high: Math.max(prev, t.priceUsd),
      low: Math.min(prev, t.priceUsd),
      close: t.priceUsd,
      volume: t.valueUsd,
    }
  })
}

function packAdjacent(candles: TvCandle[], stepSec: number): TvCandle[] {
  if (candles.length < 2 || !(stepSec > 0)) return candles
  const step = stepSec * 1000
  const t0 = candles[0].time
  return candles.map((c, i) => ({ ...c, time: t0 + i * step }))
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params
  const token = (raw || '').trim()
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

  const raw: TvCandle[] = TICK_RES.has(resolution)
    ? tickCandles(tape.trades)
    : buildCandles(tape.trades, bucketSec, fallback).map((c) => ({
        time: c.time * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }))

  const candles = packAdjacent(
    raw.filter((c) => c.volume > 0 || c.open !== c.close),
    bucketSec,
  )

  return NextResponse.json(
    { candles: candles.length ? candles : raw, resolution },
    { headers: { 'Cache-Control': 's-maxage=15, stale-while-revalidate=30' } },
  )
}
