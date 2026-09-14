/**
 * node --test lib/arc-kv-bounded.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HGETALL_SAFE_FIELDS,
  HSCAN_COUNT,
  KV_HASH_FIELD_CHUNK,
  KV_LIST_CHUNK,
  cappedNewest,
  chunkArray,
  ingestLedgerRecord,
  ingestLedgerScanItems,
  tradeTapePageRange,
} from './arc-kv-bounded.ts'

test('chunks stay well under a 10MB command', () => {
  assert.equal(KV_LIST_CHUNK, 50)
  assert.equal(KV_HASH_FIELD_CHUNK, 500)
  assert.ok(HGETALL_SAFE_FIELDS < 20_000)
  assert.ok(HSCAN_COUNT <= 2_000)
})

test('chunkArray splits evenly and leftover', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunkArray([], 50), [])
  assert.deepEqual(chunkArray(['a'], 50), [['a']])
})

test('cappedNewest keeps the tail of an oldest→newest catch-up', () => {
  const fresh = [1, 2, 3, 4, 5]
  assert.deepEqual(cappedNewest(fresh, 3), [3, 4, 5])
  assert.deepEqual(cappedNewest(fresh, 400), fresh)
  assert.deepEqual(cappedNewest(fresh, 0), [])
})

test('trade tape page 1 is the newest tail', () => {
  // 400-long list, offset 0 limit 50 → indices 350..399
  assert.deepEqual(tradeTapePageRange(400, 0, 50), { start: 350, end: 399 })
  // limit 400 (ohlcv) is the whole cap
  assert.deepEqual(tradeTapePageRange(400, 0, 400), { start: 0, end: 399 })
})

test('trade tape page 2 and a short list', () => {
  assert.deepEqual(tradeTapePageRange(400, 50, 50), { start: 300, end: 349 })
  // limit larger than the list: whole list
  assert.deepEqual(tradeTapePageRange(30, 0, 50), { start: 0, end: 29 })
  // offset past the end: empty (JS slice used to return [])
  assert.equal(tradeTapePageRange(30, 50, 50), null)
  assert.equal(tradeTapePageRange(0, 0, 50), null)
})

test('ingest ledger skips zeros and pairs HSCAN items', () => {
  const fromHash = new Map()
  ingestLedgerRecord({ '0xaa': '10', '0xbb': '0', '0xcc': '5' }, fromHash)
  assert.equal(fromHash.size, 2)
  assert.equal(fromHash.get('0xaa'), 10n)
  assert.equal(fromHash.has('0xbb'), false)

  const fromScan = new Map()
  ingestLedgerScanItems(['0xaa', '10', '0xbb', '0', '0xcc', '5', 'odd-leftover'], fromScan)
  assert.deepEqual([...fromScan.entries()], [...fromHash.entries()])
})
