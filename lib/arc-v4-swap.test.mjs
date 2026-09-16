/**
 * node --experimental-strip-types --test lib/arc-v4-swap.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keccak256, concat, pad, toHex } from 'viem'

test('1:1 sqrt price exact-in, 1% output fee', async () => {
  const { estimateEveV4ExactIn } = await import('./arc-v4-swap.ts')
  const Q96 = 2n ** 96n
  const one = 10n ** 18n
  const out = estimateEveV4ExactIn({
    amountIn: one,
    zeroForOne: true,
    sqrtPriceX96: Q96,
    feeBps: 100,
  })
  assert.equal(out, (one * 9900n) / 10000n)
  const back = estimateEveV4ExactIn({
    amountIn: one,
    zeroForOne: false,
    sqrtPriceX96: Q96,
    feeBps: 100,
  })
  assert.equal(back, out)
})

test('zero / uninit price quotes 0, not 1 wei', async () => {
  const { estimateEveV4ExactIn } = await import('./arc-v4-swap.ts')
  assert.equal(
    estimateEveV4ExactIn({ amountIn: 10n ** 18n, zeroForOne: true, sqrtPriceX96: 0n, feeBps: 100 }),
    0n,
  )
  assert.equal(
    estimateEveV4ExactIn({ amountIn: 0n, zeroForOne: true, sqrtPriceX96: 2n ** 96n, feeBps: 100 }),
    0n,
  )
})

test('cirBTC-like sell of ~2534 tokens is ~0.00013 quote, not 1 wei', async () => {
  const { estimateEveV4ExactIn } = await import('./arc-v4-swap.ts')
  // 55 cirBTC virtual / 1e9 tokens → 5.5e-8 cirBTC per token (8dp quote, 18dp token).
  // token is currency0: raw quote/token = 5.5e-8 * 10^(8-18) = 5.5e-18
  // sqrtP^2 / 2^192 = 5.5e-18 → sqrtP = 2^96 * sqrt(5.5e-18)
  const Q96 = 2n ** 96n
  const rawNum = 55n * 10n ** 8n // 55 cirBTC in 8dp
  const rawDen = 10n ** 9n * 10n ** 18n // 1e9 tokens in 18dp
  // sqrtPriceX96 ≈ Q96 * sqrt(rawNum/rawDen). Use integer: sqrtP^2 = Q192 * rawNum / rawDen
  // Build a nearby sqrt by taking integer sqrt of (Q96^2 * rawNum / rawDen).
  const q192 = 2n ** 192n
  const target = (q192 * rawNum) / rawDen
  const sqrtP = newtonSqrt(target)
  const amountIn = 2534n * 10n ** 18n
  const out = estimateEveV4ExactIn({
    amountIn,
    zeroForOne: true,
    sqrtPriceX96: sqrtP,
    feeBps: 100,
  })
  // ~2534 * 5.5e-8 * 0.99 cirBTC ≈ 0.000138 raw 8dp → 13800-ish.
  assert.ok(out > 10_000n, `got ${out}`)
  assert.ok(out < 20_000n, `got ${out}`)
  assert.notEqual(out, 1n)
})

test('pool state slot is keccak(poolId || uint256(6))', async () => {
  const { eveV4PoolStateSlot } = await import('./arc-v4-swap.ts')
  const poolId = `0x${'ab'.repeat(32)}`
  const expect = keccak256(concat([poolId, pad(toHex(6n), { size: 32 })]))
  assert.equal(eveV4PoolStateSlot(poolId), expect)
})

test('extsload word keeps the low 160 bits as sqrtPriceX96', async () => {
  const { sqrtPriceX96FromExtsload } = await import('./arc-v4-swap.ts')
  const sqrt = 2n ** 96n
  const tick = 0n
  const packed = sqrt | (tick << 160n)
  assert.equal(sqrtPriceX96FromExtsload(packed), sqrt)
})

function newtonSqrt(n) {
  if (n <= 0n) return 0n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}
