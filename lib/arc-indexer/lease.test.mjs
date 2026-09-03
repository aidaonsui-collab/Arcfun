/**
 * node --experimental-strip-types --test lib/arc-indexer/lease.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDedicatedLeaseLive } from './lease.ts'

test('fresh dedicated lease is live; vercel-cron is not', () => {
  const now = 1_788_300_000_000
  assert.equal(
    isDedicatedLeaseLive({ owner: 'jessica', host: 'jessica.local', pid: 1, at: now - 5_000 }, now),
    true,
  )
  assert.equal(
    isDedicatedLeaseLive({ owner: 'vercel-cron', host: 'iad1', pid: 0, at: now }, now),
    false,
  )
})

test('stale dedicated lease expires so the Vercel cron can take over', () => {
  const now = 1_788_300_000_000
  assert.equal(
    isDedicatedLeaseLive({ owner: 'jessica', host: 'jessica.local', pid: 1, at: now - 60_000 }, now),
    false,
  )
  assert.equal(isDedicatedLeaseLive(null, now), false)
})
