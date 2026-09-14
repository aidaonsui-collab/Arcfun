/**
 * node --experimental-strip-types --test lib/rwa-bundle.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('equal weights pad the last slice so they sum to 100%', async () => {
  const { equalWeightsBps, basketWeightSum } = await import('./rwa-bundle.ts')
  assert.deepEqual(equalWeightsBps(1), [10_000])
  assert.deepEqual(equalWeightsBps(2), [5_000, 5_000])
  assert.deepEqual(equalWeightsBps(3), [3_333, 3_333, 3_334])
  assert.equal(
    basketWeightSum(equalWeightsBps(3).map((weightBps) => ({ weightBps }))),
    10_000,
  )
})

test('pool key sorts quote and asset', async () => {
  const { poolKeyForQuoteAsset } = await import('./rwa-bundle.ts')
  const quote = '0x3600000000000000000000000000000000000000'
  const asset = '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C'
  const key = poolKeyForQuoteAsset(quote, asset)
  assert.equal(key.currency0.toLowerCase() < key.currency1.toLowerCase(), true)
  assert.equal(key.fee, 3_000)
  assert.equal(key.tickSpacing, 60)
})

test('basketValid rejects quote-in-basket, dupes, and bad weights', async () => {
  const { basketValid } = await import('./rwa-bundle.ts')
  const quote = '0x3600000000000000000000000000000000000000'
  const a = '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C'
  const b = '0x1111111111111111111111111111111111111111'
  const row = (address, weightBps, symbol = 'X') => ({
    id: address,
    symbol,
    address,
    weightBps,
    fee: 3_000,
    tickSpacing: 60,
    hooks: '',
  })
  assert.equal(basketValid([], { quote, mode: 'all' }).ok, false)
  assert.equal(basketValid([row(quote, 10_000)], { quote, mode: 'all' }).ok, false)
  assert.equal(basketValid([row(a, 5_000), row(a, 5_000)], { quote, mode: 'all' }).ok, false)
  assert.equal(basketValid([row(a, 4_000)], { quote, mode: 'all' }).ok, false)
  assert.equal(basketValid([row(a, 6_000), row(b, 4_000)], { quote, mode: 'all' }).ok, true)
  assert.equal(basketValid([row(a, 0)], { quote, mode: 'rotate' }).ok, true)
})
