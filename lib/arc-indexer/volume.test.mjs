/**
 * node --test lib/arc-indexer/volume.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketVolumeWindows, tapeSaturatedInWindow } from './volume.ts'

const NOW = 1_800_000_000
const H = 3600

test('bucketVolumeWindows sums each rolling window and tracks the newest ts', () => {
  const trades = [
    { ts: NOW - 30 * H, valueUsd: 100 }, // outside 24h
    { ts: NOW - 20 * H, valueUsd: 10 }, // 24h only
    { ts: NOW - 10 * H, valueUsd: 20 }, // 24h + 12h
    { ts: NOW - 5 * H, valueUsd: 30 }, // 24h + 12h + 6h
    { ts: NOW - 30 * 60, valueUsd: 40 }, // all four
  ]
  const w = bucketVolumeWindows(trades, NOW)
  assert.equal(w.volume24h, 10 + 20 + 30 + 40)
  assert.equal(w.volume12h, 20 + 30 + 40)
  assert.equal(w.volume6h, 30 + 40)
  assert.equal(w.volume1h, 40)
  assert.equal(w.lastTradeAt, NOW - 30 * 60)
})

test('bucketVolumeWindows ignores zero/negative value and zero ts, but still advances lastTradeAt', () => {
  const w = bucketVolumeWindows(
    [
      { ts: NOW - H, valueUsd: 0 },
      { ts: 0, valueUsd: 50 },
      { ts: NOW - 2 * H, valueUsd: -5 },
      { ts: NOW - H, valueUsd: 25 },
    ],
    NOW,
  )
  assert.equal(w.volume24h, 25)
  assert.equal(w.lastTradeAt, NOW - H)
})

test('tapeSaturatedInWindow: below cap is never saturated', () => {
  const trades = Array.from({ length: 399 }, (_, i) => ({ ts: NOW - i * 60 }))
  assert.equal(tapeSaturatedInWindow(trades, NOW, 400), false)
})

test('tapeSaturatedInWindow: full tape whose oldest entry is inside 24h -> needs rescan', () => {
  // 400 trades, one per minute -> spans ~6.6h, oldest well inside 24h
  const trades = Array.from({ length: 400 }, (_, i) => ({ ts: NOW - (399 - i) * 60 }))
  assert.equal(trades[0].ts, NOW - 399 * 60)
  assert.equal(tapeSaturatedInWindow(trades, NOW, 400), true)
})

test('tapeSaturatedInWindow: full tape that still spans >24h -> tape is fine, no rescan', () => {
  // 400 trades, one per hour -> oldest is ~16.6 days back
  const trades = Array.from({ length: 400 }, (_, i) => ({ ts: NOW - (399 - i) * H }))
  assert.equal(tapeSaturatedInWindow(trades, NOW, 400), false)
})

test('tapeSaturatedInWindow: empty tape', () => {
  assert.equal(tapeSaturatedInWindow([], NOW, 400), false)
})
