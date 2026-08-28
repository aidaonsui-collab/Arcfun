/**
 * node --test lib/arc-blitz-guards.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { xAccountTooNew, xFollowersTooLow } from './arc-blitz-guards.ts'

test('account younger than 30 days is rejected', () => {
  const now = Date.parse('2026-08-28T00:00:00Z')
  assert.equal(xAccountTooNew('2026-08-20T00:00:00Z', 30, now), true)
})

test('account older than 30 days is allowed', () => {
  const now = Date.parse('2026-08-28T00:00:00Z')
  assert.equal(xAccountTooNew('2026-01-01T00:00:00Z', 30, now), false)
})

test('missing created_at is rejected', () => {
  assert.equal(xAccountTooNew(undefined, 30), true)
})

test('age check disabled at 0 days', () => {
  assert.equal(xAccountTooNew(undefined, 0), false)
})

test('followers below floor rejected', () => {
  assert.equal(xFollowersTooLow(12, 50), true)
})

test('followers at floor allowed', () => {
  assert.equal(xFollowersTooLow(50, 50), false)
})

test('missing followers rejected', () => {
  assert.equal(xFollowersTooLow(undefined, 50), true)
})
