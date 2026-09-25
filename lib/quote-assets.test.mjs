/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/quote-assets.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quoteAsset, quoteKind } from './quote-assets.ts'

test('quote chips map USDC / MMF / equity / btc / gold', () => {
  assert.equal(quoteKind('USDC'), 'usdc')
  assert.equal(quoteKind('usyc'), 'mmf')
  assert.equal(quoteKind('BUIDL'), 'mmf')
  assert.equal(quoteKind('crcl'), 'equity')
  assert.equal(quoteKind('cirBTC'), 'btc')
  assert.equal(quoteKind('xaum'), 'gold')
  assert.equal(quoteKind('USDCAT'), 'usdcat')
  assert.equal(quoteKind('USDC'), 'usdc')
  assert.equal(quoteAsset('cirbtc').mark, '/marks/cirbtc.svg')
  assert.equal(quoteAsset('xaum').label, 'Gold')
  assert.equal(quoteAsset('usdcat').mark, '/marks/usdcat.jpg')
  assert.equal(quoteAsset('usdcat').symbol, 'USDCAT')
})
