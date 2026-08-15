/**
 * Bucket indexed swap tape into OHLCV.
 * Only buckets that had a trade are emitted — empty 5m/15m slots are skipped, so a quiet
 * stretch doesn't sit in this array as an explicit gap entry. That alone isn't enough to make
 * candles sit adjacent on screen, though: lightweight-charts spaces bars by each bar's actual
 * `time` value along a real time axis, same as any TradingView-family chart — two real candles
 * separated by hours of silence still render with a wide blank stretch between them unless the
 * chart itself is told to ignore real elapsed time. That part is TokenChart.tsx's job (synthetic,
 * evenly-spaced x-axis) — see its file-top comment. Found live 2026-08-15: this file's dropped
 * buckets were doing their part correctly, but the chart wasn't, so the "pack like RadarDEX"
 * goal was only half-implemented and quiet periods still showed as gaps.
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
