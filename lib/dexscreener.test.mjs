/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/dexscreener.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dexScreenerEmbedSrc, dexScreenerPairId, dexScreenerPairUrl } from './dexscreener.ts'

const ZERO = '0x0000000000000000000000000000000000000000'
const V3 = '0xA4B5318c06447b64203c98EBB9547C4baE2BabcD'
const V4 = '0x657a630d6c74b3991c2577ac372a0620901ff3e1e48de955ed921c1b75491134'

test('V3 Instant / Reflection uses the Uni pool address', () => {
  const id = dexScreenerPairId({
    dexVenue: 'v3',
    instantMeta: { uniPool: V3, quote: 'USDC' },
  })
  assert.equal(id, V3.toLowerCase())
  assert.equal(dexScreenerPairUrl({ instantMeta: { uniPool: V3 } }), `https://dexscreener.com/arc/${V3.toLowerCase()}`)
})

test('V4 Instant / RWA uses the Uniswap v4 poolId, not a zero uniPool', () => {
  const pool = {
    dexVenue: 'v4',
    instantMeta: { uniPool: ZERO, poolId: V4, quote: 'cirBTC', quoteToken: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0' },
  }
  assert.equal(dexScreenerPairId(pool), V4.toLowerCase())
  const src = dexScreenerEmbedSrc(pool)
  assert.ok(src?.startsWith(`https://dexscreener.com/arc/${V4.toLowerCase()}?`))
  assert.ok(src?.includes('embed=1'))
  assert.ok(src?.includes('chartType=usd'))
  assert.ok(src?.includes('theme=dark'))
})

test('no pair id when Instant has not written a pool yet', () => {
  assert.equal(dexScreenerPairId({ instantMeta: { uniPool: ZERO } }), null)
  assert.equal(dexScreenerEmbedSrc({ instantMeta: {} }), null)
})
