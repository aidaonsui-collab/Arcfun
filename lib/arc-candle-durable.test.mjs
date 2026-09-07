/**
 * node --experimental-strip-types --test lib/arc-candle-durable.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCandleDurableAllowlist,
  parseCandleDurableAlways,
  parseCandleDurableMax,
} from './arc-candle-durable.ts'

const EVE = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = '0xcccccccccccccccccccccccccccccccccccccccc'
const D = '0xdddddddddddddddddddddddddddddddddddddddd'

test('parseCandleDurableMax defaults to 20; 0 means unlimited', () => {
  assert.equal(parseCandleDurableMax(undefined), 20)
  assert.equal(parseCandleDurableMax(''), 20)
  assert.equal(parseCandleDurableMax('20'), 20)
  assert.equal(parseCandleDurableMax('0'), 0)
  assert.equal(parseCandleDurableMax('7'), 7)
  assert.equal(parseCandleDurableMax('-1'), 20)
  assert.equal(parseCandleDurableMax('nope'), 20)
})

test('parseCandleDurableAlways defaults to $EVE', () => {
  const def = parseCandleDurableAlways(undefined)
  assert.equal(def.size, 1)
  assert.ok(def.has(EVE.toLowerCase()))
  const custom = parseCandleDurableAlways(`${A}, ${B}`)
  assert.deepEqual([...custom].sort(), [A, B].map((x) => x.toLowerCase()).sort())
})

test('buildCandleDurableAllowlist takes top-N by volume and unions always', () => {
  const volumes = { [A]: 100, [B]: 50, [C]: 10, [D]: 1 }
  const { unlimited, allowed } = buildCandleDurableAllowlist({
    maxTokens: 2,
    always: [EVE],
    volumes,
  })
  assert.equal(unlimited, false)
  assert.ok(allowed.has(A))
  assert.ok(allowed.has(B))
  assert.ok(allowed.has(EVE.toLowerCase()))
  assert.ok(!allowed.has(C))
  assert.ok(!allowed.has(D))
  assert.equal(allowed.size, 3)
})

test('buildCandleDurableAllowlist maxTokens=0 is unlimited', () => {
  const { unlimited, allowed } = buildCandleDurableAllowlist({
    maxTokens: 0,
    always: [EVE],
    volumes: { [A]: 1 },
  })
  assert.equal(unlimited, true)
  assert.ok(allowed.has(EVE.toLowerCase()))
})

test('always token outside top-N is still included', () => {
  const { allowed } = buildCandleDurableAllowlist({
    maxTokens: 1,
    always: [D],
    volumes: { [A]: 100, [B]: 50, [D]: 0 },
  })
  assert.ok(allowed.has(A))
  assert.ok(allowed.has(D))
  assert.ok(!allowed.has(B))
})
