/**
 * Bucket indexed swap tape into OHLCV.
 * Only buckets that had a trade are emitted — empty 5m/15m slots are skipped so
 * candles sit adjacent (RadarDEX). lightweight-charts already spaces by index,
 * not wall-clock, so filling quiet buckets just draws invisible dojis ("gaps").
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

  for (const t of chronological) {
    const bucketTime = Math.floor(t.ts / bucketSec) * bucketSec
    const existing = byBucket.get(bucketTime)
    if (!existing) {
      byBucket.set(bucketTime, {
        time: bucketTime,
        open: t.priceUsd,
        high: t.priceUsd,
        low: t.priceUsd,
        close: t.priceUsd,
        volume: t.valueUsd,
      })
    } else {
      existing.high = Math.max(existing.high, t.priceUsd)
      existing.low = Math.min(existing.low, t.priceUsd)
      existing.close = t.priceUsd
      existing.volume += t.valueUsd
    }
  }

  const real = [...byBucket.values()].sort((a, b) => a.time - b.time)
  return real.length > MAX_BUCKETS ? real.slice(-MAX_BUCKETS) : real
}
