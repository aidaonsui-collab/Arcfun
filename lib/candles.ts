/**
 * Bucket indexed swap tape into OHLCV.
 *
 * `buildCandles` emits only buckets that had a trade (sparklines, MCP, candle-mode OHLC).
 * The token page line chart uses `fillCandleGaps` on top of that so quiet stretches stay on
 * a real time axis as a flat last-price shelf — the RadarDEX / mountain-chart look.
 */
import type { EvmTrade } from './evm-trades'

export interface Candle {
  time: number // unix seconds, bucket start
  open: number
  high: number
  low: number
  close: number
  volume: number // USD
}

/**
 * Interval (seconds) per chart control — these are candle widths, not "last N minutes".
 * Matches pools.trade's 5m / 15m / 1h / 1d / 1w resolutions.
 */
export const RANGE_BUCKET_SEC = {
  '5M': 300,
  '15M': 900,
  '1H': 3_600,
  '1D': 86_400,
  '1W': 604_800,
} as const

/** Cap how many trade-buckets we keep (most recent). */
const MAX_BUCKETS = 720

export function scaleCandles(candles: Candle[], mult: number): Candle[] {
  if (!(mult > 0) || mult === 1) return candles
  return candles.map((c) => ({
    ...c,
    open: c.open * mult,
    high: c.high * mult,
    low: c.low * mult,
    close: c.close * mult,
    // volume stays USD notional
  }))
}

/**
 * Build ascending OHLCV from the full trade tape.
 * Quiet intervals are omitted (no flat carry-forward bars).
 */
export function buildCandles(trades: EvmTrade[], bucketSec: number, fallbackPrice: number): Candle[] {
  const priced = trades.filter((t) => t.ts > 0 && t.priceUsd > 0)
  if (priced.length === 0) {
    if (!(fallbackPrice > 0)) return []
    const now = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec
    return [{ time: now, open: fallbackPrice, high: fallbackPrice, low: fallbackPrice, close: fallbackPrice, volume: 0 }]
  }

  const chronological = [...priced].sort((a, b) => a.ts - b.ts)
  const byBucket = new Map<number, Candle>()
  let lastClose = 0

  for (const t of chronological) {
    const bucketTime = Math.floor(t.ts / bucketSec) * bucketSec
    const existing = byBucket.get(bucketTime)
    if (!existing) {
      // Open at the prior close so a one-print bucket still has a body (robinpad ohlcv).
      const open = lastClose > 0 ? lastClose : t.priceUsd
      byBucket.set(bucketTime, {
        time: bucketTime,
        open,
        high: Math.max(open, t.priceUsd),
        low: Math.min(open, t.priceUsd),
        close: t.priceUsd,
        volume: t.valueUsd,
      })
    } else {
      existing.high = Math.max(existing.high, t.priceUsd)
      existing.low = Math.min(existing.low, t.priceUsd)
      existing.close = t.priceUsd
      existing.volume += t.valueUsd
    }
    lastClose = t.priceUsd
  }

  const real = [...byBucket.values()].sort((a, b) => a.time - b.time)
  return real.length > MAX_BUCKETS ? real.slice(-MAX_BUCKETS) : real
}

/** Cap filled bars so a 5M chart over weeks doesn't explode. */
const MAX_FILLED = 1_500

/**
 * Insert last-close bars into quiet buckets from the first print through `untilTs`
 * (default: now). The line stays on wall-clock time; dead hours read as a flat shelf.
 */
export function fillCandleGaps(
  candles: Candle[],
  bucketSec: number,
  untilTs?: number,
): Candle[] {
  if (candles.length === 0 || !(bucketSec > 0)) return candles
  const sorted = [...candles].sort((a, b) => a.time - b.time)
  const lastTrade = sorted[sorted.length - 1].time
  const end = Math.floor((untilTs ?? Math.floor(Date.now() / 1000)) / bucketSec) * bucketSec
  let start = sorted[0].time
  const tail = Math.max(end, lastTrade)
  const span = Math.floor((tail - start) / bucketSec) + 1
  if (span > MAX_FILLED) start = tail - (MAX_FILLED - 1) * bucketSec

  const byTime = new Map(sorted.map((c) => [c.time, c]))
  let last = sorted.find((c) => c.time <= start) ?? sorted[0]
  const out: Candle[] = []
  for (let t = start; t <= tail; t += bucketSec) {
    const hit = byTime.get(t)
    if (hit) {
      last = hit
      out.push(hit)
    } else {
      out.push({
        time: t,
        open: last.close,
        high: last.close,
        low: last.close,
        close: last.close,
        volume: 0,
      })
    }
  }
  return out
}

/** First open / range high-low / last close / summed volume. Ignores empty carry bars. */
export function sessionOhlc(candles: Candle[]): Candle | null {
  const live = candles.filter((c) => c.volume > 0 || c.high !== c.low || c.open !== c.close)
  const src = live.length > 0 ? live : candles
  if (src.length === 0) return null
  let high = src[0].high
  let low = src[0].low
  let volume = 0
  for (const c of src) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
    volume += c.volume
  }
  return {
    time: src[src.length - 1].time,
    open: src[0].open,
    high,
    low,
    close: src[src.length - 1].close,
    volume,
  }
}

/** % change from price ~windowSec ago (or first print if the token is younger) to last print. */
export function priceChangeFromTrades(trades: EvmTrade[], windowSec = 86_400): number {
  const priced = trades.filter((t) => t.ts > 0 && t.priceUsd > 0)
  if (priced.length < 2) return 0
  const chronological = [...priced].sort((a, b) => a.ts - b.ts)
  const now = Math.floor(Date.now() / 1000)
  const cutoff = now - windowSec
  let start = chronological[0].priceUsd
  for (let i = chronological.length - 1; i >= 0; i--) {
    if (chronological[i].ts <= cutoff) {
      start = chronological[i].priceUsd
      break
    }
  }
  const end = chronological[chronological.length - 1].priceUsd
  if (!(start > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return 0
  return ((end - start) / start) * 100
}

/** 5m candle closes — same buckets as the token chart default — for rail sparklines. */
export function sparkClosesFromTrades(
  trades: EvmTrade[],
  fallbackPrice = 0,
  maxPoints = 36,
): number[] {
  const candles = buildCandles(trades, RANGE_BUCKET_SEC['5M'], fallbackPrice)
  const closes = candles.map((c) => c.close).filter((n) => n > 0)
  return closes.length > maxPoints ? closes.slice(-maxPoints) : closes
}
