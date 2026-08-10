/**
 * Bucket raw Arc Instant swaps (lib/arc-trades.ts) into OHLCV candles for the chart.
 * Real trade-derived data — replaces the old areaChartPaths() synthetic sparkline
 * (lib/ui-format.ts), which was seeded random noise, not price history.
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

/** Bucket width (seconds) per chart range — tuned to the ~50-trade tape arc-trades.ts returns. */
export const RANGE_BUCKET_SEC = {
  '5M': 300, // 5-minute candles
  '15M': 900, // 15-minute candles
  '1H': 60, // 1-minute candles
  '1D': 900, // 15-minute candles
  '1W': 3600, // 1-hour candles
} as const

/** Never backfill more than this many empty buckets — keeps an old/quiet token's chart from
 *  rendering thousands of flat bars if it just hasn't traded in a while. */
const MAX_BACKFILL_BUCKETS = 400

/**
 * Build ascending OHLCV candles from a trade tape (any order in, any order out — sorted here).
 * `fallbackPrice` seeds a single flat candle when there's no trade history yet, so the chart
 * always has something sane to render instead of going blank.
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

  // Backfill gaps (real trade buckets to "now") with flat candles at the last known close.
  // Without this, a token that only has 1-2 trades produces 1-2 candles total, and
  // lightweight-charts' fitContent() stretches those into giant blocks filling the whole
  // container — this keeps bar count (and therefore bar width) reasonable regardless of how
  // quiet the token has been.
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec
  const out: Candle[] = []
  let lastClose = real[0].open
  let cursor = real[0].time
  let bucketsEmitted = 0
  let ri = 0
  while (cursor <= nowBucket && bucketsEmitted < MAX_BACKFILL_BUCKETS) {
    const hit = ri < real.length && real[ri].time === cursor ? real[ri] : null
    if (hit) {
      out.push(hit)
      lastClose = hit.close
      ri++
    } else {
      out.push({ time: cursor, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0 })
    }
    cursor += bucketSec
    bucketsEmitted++
  }
  // If the backfill cap was hit before reaching "now", just tack on any remaining real buckets
  // (real trades always win over the cap — the cap only limits synthetic flat filler).
  while (ri < real.length) {
    out.push(real[ri])
    ri++
  }
  return out
}
