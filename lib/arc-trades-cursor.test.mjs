/**
 * node --test lib/arc-trades-cursor.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { staleTapeRewindFrom, shouldPersistScanCursor } from './arc-trades-cursor.ts'

test('stale tape rewinds from the last fill block, not a 12k window', () => {
  const from = staleTapeRewindFrom({
    head: 18635625n,
    lastTradeBlock: 18611398,
    lastTradeTs: 1_788_268_081,
    nowSec: 1_788_268_081 + 3 * 3600,
  })
  assert.equal(from, 18611399n)
})

test('fresh tape does not rewind', () => {
  const from = staleTapeRewindFrom({
    head: 18635625n,
    lastTradeBlock: 18635000,
    lastTradeTs: 1_788_280_000,
    nowSec: 1_788_280_000 + 60,
  })
  assert.equal(from, null)
})

test('no last block falls back to a 12k window', () => {
  const from = staleTapeRewindFrom({
    head: 20_000n,
    lastTradeBlock: 0,
    lastTradeTs: 0,
    nowSec: 1_788_280_000,
  })
  assert.equal(from, 20_000n - 12_000n + 1n)
})

test('empty scan while stale must not park the cursor at head', () => {
  assert.equal(
    shouldPersistScanCursor({
      foundTrades: 0,
      scannedTo: 18635625n,
      from: 18611399n,
      tapeIsStale: true,
    }),
    false,
  )
})

test('empty scan on a fresh tape may advance the cursor', () => {
  assert.equal(
    shouldPersistScanCursor({
      foundTrades: 0,
      scannedTo: 18635625n,
      from: 18635000n,
      tapeIsStale: false,
    }),
    true,
  )
})

test('found trades always persist when the scan advanced', () => {
  assert.equal(
    shouldPersistScanCursor({
      foundTrades: 10,
      scannedTo: 18635625n,
      from: 18611399n,
      tapeIsStale: true,
    }),
    true,
  )
})

test('failed chunk (scannedTo < from) never persists', () => {
  assert.equal(
    shouldPersistScanCursor({
      foundTrades: 0,
      scannedTo: 18611398n,
      from: 18611399n,
      tapeIsStale: false,
    }),
    false,
  )
})
