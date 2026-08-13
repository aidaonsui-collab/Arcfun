/**
 * Bucket indexed swap tape into OHLCV — same shape pools.trade uses
 * (interval candles across full history, carry last close through quiet buckets).
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

/** Cap empty carry-forward so a quiet token doesn't emit thousands of flat bars. */
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
 * Empty buckets between first trade and now carry the last close (pools.trade style)
 * so the time axis is real dates, not two stretched blocks.
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
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec
  const first = real[0].time
  const span = Math.floor((nowBucket - first) / bucketSec) + 1
  // If history is longer than the cap, start late enough to still include "now"
  // and keep the most recent real trades.
  let cursor = first
  if (span > MAX_BUCKETS) {
    cursor = nowBucket - (MAX_BUCKETS - 1) * bucketSec
    const earliestReal = real.find((c) => c.time >= cursor)
    if (earliestReal && earliestReal.time < cursor) cursor = earliestReal.time
  }

  const out: Candle[] = []
  let lastClose = real[0].open
  let ri = 0
  while (ri < real.length && real[ri].time < cursor) {
    lastClose = real[ri].close
    ri++
  }

  while (cursor <= nowBucket && out.length < MAX_BUCKETS) {
    const hit = ri < real.length && real[ri].time === cursor ? real[ri] : null
    if (hit) {
      out.push(hit)
      lastClose = hit.close
      ri++
    } else {
      out.push({
        time: cursor,
        open: lastClose,
        high: lastClose,
        low: lastClose,
        close: lastClose,
        volume: 0,
      })
    }
    cursor += bucketSec
  }
  while (ri < real.length) {
    out.push(real[ri])
    ri++
  }
  return out
}
