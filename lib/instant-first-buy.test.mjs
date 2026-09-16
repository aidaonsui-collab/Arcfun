/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/instant-first-buy.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateInstantFirstBuyTokens } from './instant-first-buy.ts'

const VQ_USDC = 5_500_000_000n // 5500e6

test('$100 first buy at $5500 seed, 1% hook fee, is ~18.86M tokens', () => {
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 100_000_000n,
    virtualQuoteRaw: VQ_USDC,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 18_800_000 && n < 18_900_000)
})

test('zero buy or zero virtual quote returns 0', () => {
  assert.equal(
    estimateInstantFirstBuyTokens({ quoteInRaw: 0n, virtualQuoteRaw: VQ_USDC, feeBps: 100 }),
    0,
  )
  assert.equal(
    estimateInstantFirstBuyTokens({ quoteInRaw: 100_000_000n, virtualQuoteRaw: 0n, feeBps: 100 }),
    0,
  )
})

test('cirBTC 8dp virtual quote still pays out 18dp launch tokens', () => {
  // $5500 at $100k BTC → 0.055 cirBTC = 5_500_000 raw (8dp)
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 100_000n, // 0.001 cirBTC
    virtualQuoteRaw: 5_500_000n,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 18_000_000 && n < 20_000_000)
})

test('3% pool fee pays fewer tokens than 1%', () => {
  const opts = { quoteInRaw: 100_000_000n, virtualQuoteRaw: VQ_USDC, tokenDecimals: 18 }
  const at1 = estimateInstantFirstBuyTokens({ ...opts, feeBps: 100 })
  const at3 = estimateInstantFirstBuyTokens({ ...opts, feeBps: 300 })
  assert.ok(at3 < at1)
  assert.ok(Math.abs(at3 / at1 - 9700 / 9900) < 0.001)
})
