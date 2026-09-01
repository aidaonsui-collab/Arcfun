/**
 * node --experimental-strip-types --test lib/arc-catalog-from-index.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  catalogId,
  indexedRowToPoolToken,
  isUsableCatalogSnapshot,
  mergeCatalogTokens,
} from './arc-catalog-from-index.ts'

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
