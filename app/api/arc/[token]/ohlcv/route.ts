import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcPoolToken } from '@/lib/arc-instant-tokens'
import { buildCandles, fillCandleGaps, MAX_FILLED, type Candle } from '@/lib/candles'
import { readCandlesRollup } from '@/lib/arc-candle-store'

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

/** Defensive cap on rows returned for an explicit from/to (scroll-back) request — TradingView's
 *  own from/to is already bounded by its visible-bar-count × resolution, this just guards against
 *  a pathological request asking for e.g. a decade of 1-minute bars in one shot. */
const MAX_ROWS_PER_REQUEST = 5_000

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await params
  const token = (rawToken || '').trim()
  if (!isAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }
  const resolution = req.nextUrl.searchParams.get('resolution') || '15'
  const bucketSec = RES_SEC[resolution] ?? 900

  const nowSec = Math.floor(Date.now() / 1000)
  const fromParam = req.nextUrl.searchParams.get('from')
  const toParam = req.nextUrl.searchParams.get('to')
  const toSec = toParam ? Math.min(nowSec, Math.ceil(Number(toParam))) : nowSec
  // No explicit range (first load / subscribeBars tick) → same bar-count budget fillCandleGaps
  // already caps itself at, so a first paint stays cheap no matter how much durable history a
  // token has. An explicit range (TradingView scrolling back) is honored as asked.
  const fromSec = fromParam
    ? Math.max(0, Math.floor(Number(fromParam)))
    : Math.max(0, toSec - bucketSec * MAX_FILLED)

  // Durable history (Supabase, never trimmed) — covers everything recordTrades1m/the deep
  // backfill has ever written for this token. Empty array if unconfigured or the token has none
  // yet; either way this degrades to exactly the old KV-tape-only behavior.
  const durable = await readCandlesRollup(token as Address, bucketSec, fromSec, toSec)

  // Live tail — same KV trade tape as before, still the source of truth for "right now" and for
  // whatever window the durable store hasn't caught up to yet.
  const tape = await fetchArcTrades(token as Address, { limit: 600 })
  let fallback = 0
  if (tape.trades.length === 0) {
    const pool = await fetchArcPoolToken(token as Address)
    fallback = pool?.currentPrice ?? 0
  } else {
    fallback = tape.trades[0]?.priceUsd ?? 0
  }
  const liveFilled = fillCandleGaps(buildCandles(tape.trades, bucketSec, fallback), bucketSec, toSec).filter(
    (c) => c.time >= fromSec && c.time <= toSec,
  )

  // Merge: durable candles strictly before the live tail's first bar, then the live tail itself.
  // The live tail wins on any overlap — it's the freshest, already gap-filled up to `to`, and the
  // only bucket that can still be actively updating (the in-progress "now" bucket) always lives
  // inside it, never in the durable-only region before it.
  const liveStart = liveFilled[0]?.time ?? Infinity
  let merged: Candle[] = [...durable.filter((c) => c.time < liveStart), ...liveFilled].sort((a, b) => a.time - b.time)
  if (merged.length > MAX_ROWS_PER_REQUEST) merged = merged.slice(-MAX_ROWS_PER_REQUEST)

  const candles: TvCandle[] = merged.map((c) => ({
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
