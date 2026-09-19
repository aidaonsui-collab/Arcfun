/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/instant-first-buy.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatUnits } from 'viem'
import { ARC } from './contracts-arc.ts'
import { EVE_V4_DEFAULT_VIRTUAL_QUOTE, INSTANT_MEME_TARGET_FDV_USD } from './eve-instant-v4-launchpad.ts'
import { estimateInstantFirstBuyTokens, instantListedMcUsd } from './instant-first-buy.ts'

const VQ_USDC = 3_000_000_000n // 3000e6 (RWA target FDV)

test('$100 first buy at $3000 seed, 1% hook fee, is ~34.06M tokens', () => {
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 100_000_000n,
    virtualQuoteRaw: VQ_USDC,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 34_000_000 && n < 34_100_000)
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
  // $3000 at $100k BTC → 0.03 cirBTC = 3_000_000 raw (8dp)
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 100_000n, // 0.001 cirBTC
    virtualQuoteRaw: 3_000_000n,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 32_000_000 && n < 36_000_000)
})

test('meme Instant virtual quote lists at $3000 FDV', () => {
  assert.equal(INSTANT_MEME_TARGET_FDV_USD, 3000)
  assert.equal(EVE_V4_DEFAULT_VIRTUAL_QUOTE, 3_200_000_000n)
  const vq = Number(formatUnits(EVE_V4_DEFAULT_VIRTUAL_QUOTE, 6))
  const vti = Number(formatUnits(ARC.VIRTUAL_TOKEN_INIT, 18))
  const mc = (vq * 1_000_000_000) / vti
  assert.ok(Math.abs(mc - 3000) < 0.01)
  assert.ok(Math.abs(instantListedMcUsd({ virtualQuoteRaw: EVE_V4_DEFAULT_VIRTUAL_QUOTE }) - 3000) < 0.01)
})

test('$3000 first buy at $3000 listed MC, 1% hook fee, is ~511M tokens not 226M', () => {
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 3_000_000_000n,
    virtualQuoteRaw: EVE_V4_DEFAULT_VIRTUAL_QUOTE,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 510_000_000 && n < 512_000_000)
})

test('$100 first buy at $3000 listed MC, 1% hook fee, is ~32M tokens', () => {
  const n = estimateInstantFirstBuyTokens({
    quoteInRaw: 100_000_000n,
    virtualQuoteRaw: EVE_V4_DEFAULT_VIRTUAL_QUOTE,
    tokenDecimals: 18,
    feeBps: 100,
  })
  assert.ok(n > 31_900_000 && n < 32_100_000)
})

test('3% pool fee pays fewer tokens than 1%', () => {
  const opts = { quoteInRaw: 100_000_000n, virtualQuoteRaw: VQ_USDC, tokenDecimals: 18 }
  const at1 = estimateInstantFirstBuyTokens({ ...opts, feeBps: 100 })
  const at3 = estimateInstantFirstBuyTokens({ ...opts, feeBps: 300 })
  assert.ok(at3 < at1)
  assert.ok(Math.abs(at3 / at1 - 9700 / 9900) < 0.001)
})
