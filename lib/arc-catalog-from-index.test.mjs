/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/arc-catalog-from-index.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  catalogId,
  indexedRowToPoolToken,
  isUsableCatalogSnapshot,
  mergeCatalogTokens,
} from './arc-catalog-from-index.ts'
import {
  healIndexedSpotUsdc,
  sanitizePoolTokenSpot,
} from './arc-instant-tokens.ts'
import { fmtUsd } from './ui-format.ts'

const EVE = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF'
const POOL = '0xA4B5318c06447b64203c98EBB9547C4baE2BabcD'
const FACTORY = '0xd51E6217bb3bC7586866713854Ea75B7BefF1009'
const CREATOR = '0xB5dE5615Cb49AcC3E3338B02F34560F7d3fDB9E8'
const ZERO = '0x0000000000000000000000000000000000000000'

test('empty catalog snapshot is not usable (poisoned KV must miss)', () => {
  assert.equal(isUsableCatalogSnapshot(null), false)
  assert.equal(isUsableCatalogSnapshot({ tokens: [], at: Date.now() }), false)
  assert.equal(isUsableCatalogSnapshot({ tokens: [{ id: EVE }], at: 0 }), false)
  assert.equal(
    isUsableCatalogSnapshot({ tokens: [{ id: EVE, coinType: EVE, poolId: EVE }], at: Date.now() }),
    true,
  )
})

test('indexed Instant row becomes a home-grid PoolToken', () => {
  const t = indexedRowToPoolToken(
    {
      token: EVE,
      creator: CREATOR,
      pool: POOL,
      factory: FACTORY,
      kind: 'instant',
      createdAt: 1_788_200_000,
      createdBlock: 18_000_000,
    },
    { name: 'Eve', symbol: 'EVE', imageUrl: 'https://blob.example/eve.png' },
    {
      volume1h: 10,
      volume6h: 40,
      volume12h: 80,
      volume24h: 100,
      volumeAll: 500,
      lastTradeAt: 1_788_280_000,
      updatedAt: 1,
      sparkCloses: [0.01, 0.02],
    },
  )
  assert.equal(t.symbol, 'EVE')
  assert.equal(t.name, 'Eve')
  assert.equal(t.coinType, EVE)
  assert.equal(t.instantMeta?.uniPool, POOL)
  assert.equal(t.instantMeta?.quote, 'USDC')
  assert.equal(t.launchKind, 'instant')
  assert.equal(t.currentPrice, 0.02)
  assert.equal(t.marketCap, 0.02 * 1_000_000_000)
  assert.equal(t.volume24h, 100)
  assert.equal(t.createdAt, 1_788_200_000)
  assert.equal(t.imageUrl, 'https://blob.example/eve.png')
})

test('RWA quote flag is explicit, not inferred from a missing factory env', () => {
  const t = indexedRowToPoolToken(
    {
      token: EVE,
      creator: CREATOR,
      pool: POOL,
      factory: FACTORY,
      kind: 'instant',
      createdAt: 1,
    },
    { symbol: 'EVE' },
    null,
    'USYC',
  )
  assert.equal(t.instantMeta?.quote, 'USYC')
  assert.equal(t.instantMeta?.isRwaBacked, true)
  assert.equal(t.instantMeta?.isMeme, false)
})

test('zero creator/pool still lists; reflection factory stamps launchKind', () => {
  const t = indexedRowToPoolToken(
    {
      token: EVE,
      creator: ZERO,
      pool: ZERO,
      factory: '0xa4957E724696b740b323fF3536415bB945e46828',
      kind: 'unknown',
      createdAt: 0,
    },
    { symbol: 'EVE' },
    null,
  )
  assert.equal(t.launchKind, 'reflection')
  assert.equal(t.reflection, true)
  assert.equal(t.instantMeta?.uniPool, undefined)
  assert.equal(t.creatorShort, '')
  assert.equal(t.name, 'EVE')
  assert.equal(t.currentPrice, 0)
})

test('merge keeps RPC rows and fills ids the rebuild missed', () => {
  const rpc = [{ id: '0xaaa', coinType: '0xaaa', poolId: '0xaaa', name: 'rpc' }]
  const idx = [
    { id: '0xaaa', coinType: '0xaaa', poolId: '0xaaa', name: 'idx' },
    { id: '0xbbb', coinType: '0xbbb', poolId: '0xbbb', name: 'idx-only' },
  ]
  const merged = mergeCatalogTokens(rpc, idx)
  assert.equal(merged.length, 2)
  assert.equal(merged.find((t) => catalogId(t) === '0xaaa')?.name, 'rpc')
  assert.equal(merged.find((t) => catalogId(t) === '0xbbb')?.name, 'idx-only')
})

test('newer indexer lastTradeAt wins on price/mcap; Instant metadata kept', () => {
  const rpc = [
    {
      id: '0xaaa',
      coinType: '0xaaa',
      poolId: '0xaaa',
      name: 'rpc',
      imageUrl: 'https://blob.example/rpc.png',
      instantMeta: { uniPool: '0xpool', quote: 'USDC' },
      currentPrice: 6.992e-5,
      marketCap: 69_920,
      lastTradeAt: 1_788_280_000,
      volume1h: 1,
      volume24h: 10,
      priceChange24h: 1,
      sparkCloses: [6.992e-5],
    },
    {
      id: '0xccc',
      coinType: '0xccc',
      poolId: '0xccc',
      name: 'instant-only',
      currentPrice: 0.01,
      marketCap: 10_000_000,
    },
  ]
  const idx = [
    {
      id: '0xaaa',
      coinType: '0xaaa',
      poolId: '0xaaa',
      name: 'idx',
      imageUrl: 'https://blob.example/idx.png',
      currentPrice: 9.014e-5,
      marketCap: 90_140,
      lastTradeAt: 1_788_370_000,
      volume1h: 10,
      volume6h: 40,
      volume12h: 80,
      volume24h: 100,
      volumeAll: 500,
      priceChange24h: 12,
      sparkCloses: [6.992e-5, 9.014e-5],
    },
    {
      id: '0xbbb',
      coinType: '0xbbb',
      poolId: '0xbbb',
      name: 'idx-only',
    },
  ]
  const merged = mergeCatalogTokens(rpc, idx)
  assert.equal(merged.length, 3)
  const t = merged.find((row) => catalogId(row) === '0xaaa')
  assert.equal(t?.name, 'rpc')
  assert.equal(t?.imageUrl, 'https://blob.example/rpc.png')
  assert.equal(t?.instantMeta?.uniPool, '0xpool')
  assert.equal(t?.currentPrice, 9.014e-5)
  assert.equal(t?.marketCap, 90_140)
  assert.equal(t?.lastTradeAt, 1_788_370_000)
  assert.equal(t?.volume1h, 10)
  assert.equal(t?.volume6h, 40)
  assert.equal(t?.volume12h, 80)
  assert.equal(t?.volume24h, 100)
  assert.equal(t?.volumeAll, 500)
  assert.equal(t?.priceChange24h, 12)
  assert.deepEqual(t?.sparkCloses, [6.992e-5, 9.014e-5])
  assert.equal(merged.find((row) => catalogId(row) === '0xccc')?.name, 'instant-only')
  assert.equal(merged.find((row) => catalogId(row) === '0xbbb')?.name, 'idx-only')
})

test('older indexer lastTradeAt does not replace Instant price', () => {
  const rpc = [
    {
      id: '0xaaa',
      coinType: '0xaaa',
      poolId: '0xaaa',
      name: 'rpc',
      currentPrice: 0.02,
      marketCap: 20_000_000,
      lastTradeAt: 2_000,
    },
  ]
  const idx = [
    {
      id: '0xaaa',
      coinType: '0xaaa',
      poolId: '0xaaa',
      name: 'idx',
      currentPrice: 0.01,
      marketCap: 10_000_000,
      lastTradeAt: 1_000,
    },
  ]
  const merged = mergeCatalogTokens(rpc, idx)
  assert.equal(merged[0].name, 'rpc')
  assert.equal(merged[0].currentPrice, 0.02)
  assert.equal(merged[0].marketCap, 20_000_000)
  assert.equal(merged[0].lastTradeAt, 2_000)
})

const AMG_POISON_PX = 7019179.560696072
const AMG_POISON_MC = 7019179560696072
const AMG_SPOT = AMG_POISON_PX / 1e12

test('healIndexedSpotUsdc divides 6dp-as-18 AMG prints; leaves EVE alone', () => {
  assert.ok(Math.abs(healIndexedSpotUsdc(AMG_POISON_PX) - AMG_SPOT) < 1e-15)
  assert.equal(healIndexedSpotUsdc(0.00014630216835811934), 0.00014630216835811934)
  assert.equal(healIndexedSpotUsdc(AMG_POISON_MC), 0)
})

test('sanitizePoolTokenSpot heals AMG KV poison to ~$7K FDV, not $7019T', () => {
  const row = sanitizePoolTokenSpot({
    currentPrice: AMG_POISON_PX,
    marketCap: AMG_POISON_MC,
    sparkCloses: [7090441, 7156171, AMG_POISON_PX],
  })
  assert.ok(Math.abs(row.currentPrice - AMG_SPOT) < 1e-15)
  assert.ok(Math.abs(row.marketCap - AMG_SPOT * 1_000_000_000) < 1e-6)
  assert.equal(fmtUsd(row.marketCap), '$7.0K')
  assert.deepEqual(
    row.sparkCloses,
    [7090441 / 1e12, 7156171 / 1e12, AMG_SPOT],
  )
})

test('sanitize recovers FDV when only marketCap is the 1e12 poison', () => {
  const row = sanitizePoolTokenSpot({
    currentPrice: 0,
    marketCap: AMG_POISON_MC,
  })
  assert.ok(Math.abs(row.currentPrice - AMG_SPOT) < 1e-15)
  assert.ok(Math.abs(row.marketCap - AMG_SPOT * 1_000_000_000) < 1e-6)
})

test('merge does not copy a 6dp-as-18 tape print over Instant slot0', () => {
  const rpc = [
    {
      id: '0xamg',
      coinType: '0xamg',
      poolId: '0xamg',
      name: 'rpc',
      currentPrice: 7.09e-6,
      marketCap: 7090,
      lastTradeAt: 1_000,
      sparkCloses: [7.09e-6],
    },
  ]
  const idx = [
    {
      id: '0xamg',
      coinType: '0xamg',
      poolId: '0xamg',
      name: 'idx',
      currentPrice: AMG_POISON_PX,
      marketCap: AMG_POISON_MC,
      lastTradeAt: 2_000,
      volume24h: 100,
      sparkCloses: [AMG_POISON_PX],
    },
  ]
  const merged = mergeCatalogTokens(rpc, idx)
  assert.equal(merged[0].name, 'rpc')
  assert.ok(Math.abs(merged[0].currentPrice - AMG_SPOT) < 1e-15)
  assert.ok(merged[0].marketCap < 20_000)
  assert.equal(merged[0].lastTradeAt, 2_000)
  assert.equal(merged[0].volume24h, 100)
  assert.equal(fmtUsd(merged[0].marketCap), '$7.0K')
})

test('merge keeps Instant slot0 when fallback price heals to 0', () => {
  const rpc = [
    {
      id: '0xamg',
      coinType: '0xamg',
      poolId: '0xamg',
      name: 'rpc',
      currentPrice: 7.09e-6,
      marketCap: 7090,
      lastTradeAt: 1_000,
    },
  ]
  const idx = [
    {
      id: '0xamg',
      coinType: '0xamg',
      poolId: '0xamg',
      name: 'idx',
      currentPrice: 0,
      marketCap: 0,
      lastTradeAt: 2_000,
      volume24h: 40,
    },
  ]
  const merged = mergeCatalogTokens(rpc, idx)
  assert.equal(merged[0].currentPrice, 7.09e-6)
  assert.equal(merged[0].marketCap, 7090)
  assert.equal(merged[0].lastTradeAt, 2_000)
  assert.equal(merged[0].volume24h, 40)
})

test('indexed Instant row heals poisoned spark closes', () => {
  const t = indexedRowToPoolToken(
    {
      token: EVE,
      creator: CREATOR,
      pool: POOL,
      factory: FACTORY,
      kind: 'instant',
      createdAt: 1,
    },
    { symbol: 'AMG' },
    {
      volume1h: 1,
      lastTradeAt: 2,
      updatedAt: 1,
      sparkCloses: [AMG_POISON_PX],
    },
  )
  assert.ok(Math.abs(t.currentPrice - AMG_SPOT) < 1e-15)
  assert.equal(fmtUsd(t.marketCap), '$7.0K')
  assert.deepEqual(t.sparkCloses, [AMG_SPOT])
})
