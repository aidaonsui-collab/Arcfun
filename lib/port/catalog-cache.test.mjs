/**
 * node --experimental-strip-types --test lib/port/catalog-cache.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectionFromOverlay,
  isUsablePortSnapshot,
  matchPortCollection,
  mergePortCollection,
} from './catalog-from-overlay.ts'
import { collectionStatus, mintCta } from './types.ts'

const EVE = '0xB5dE5615Cb49AcC3E3338B02F34560F7d3fDB9E8'

test('empty studio snapshot is not usable', () => {
  assert.equal(isUsablePortSnapshot(null), false)
  assert.equal(isUsablePortSnapshot({ collections: [], at: Date.now() }), false)
  assert.equal(
    isUsablePortSnapshot({ collections: [{ address: EVE, name: 'eve' }], at: Date.now() }),
    true,
  )
})

test('overlay hydrates /studio/eve slug from KV meta', () => {
  const c = collectionFromOverlay(
    EVE,
    {
      name: 'eve',
      symbol: 'EVE',
      originToken: '0x19209E55049bc613c5cC8b66B7DF7824096e78CF',
      creator: '0x23299a0d13787BFe9b40b3Ca67a3C28b83048852',
      imageUrl: 'https://blob.example/eve.png',
    },
    null,
    100,
  )
  assert.equal(c.slug, 'eve')
  assert.equal(c.originSymbol, 'EVE')
  assert.equal(c.minted, 0)
  assert.equal(c.maxSupply, 0)
  assert.equal(c.revealed, true)
  assert.equal(matchPortCollection([c], 'eve')?.address, EVE)
  assert.equal(matchPortCollection([c], 'EVE')?.address, EVE)
})

test('uploaded item count is not minted or maxSupply', () => {
  const c = collectionFromOverlay(
    EVE,
    { name: 'eve', symbol: 'EVE' },
    { minted: 12, maxSupply: 1000, name: 'eve', address: EVE },
    100,
  )
  assert.equal(c.minted, 12)
  assert.equal(c.maxSupply, 1000)
  assert.equal(collectionStatus(c), 'soon')
})

test('merge keeps last-good minted/maxSupply when overlay has none', () => {
  const merged = mergePortCollection(
    { minted: 12, maxSupply: 1000, mintPriceUsdc: 5, publicStart: 9, name: 'old' },
    { minted: 0, maxSupply: 0, mintPriceUsdc: 0, publicStart: 0, name: 'eve', description: 'desk' },
  )
  assert.equal(merged.name, 'eve')
  assert.equal(merged.description, 'desk')
  assert.equal(merged.minted, 12)
  assert.equal(merged.maxSupply, 1000)
  assert.equal(merged.mintPriceUsdc, 5)
  assert.equal(merged.publicStart, 9)
})

test('sold out requires a real maxSupply and a full mint', () => {
  assert.equal(collectionStatus({ minted: 0, maxSupply: 0, publicStart: 0, allowlist: false }), 'soon')
  assert.equal(collectionStatus({ minted: 12, maxSupply: 1000, publicStart: 1, allowlist: false }), 'live')
  assert.equal(collectionStatus({ minted: 1000, maxSupply: 1000, publicStart: 1, allowlist: false }), 'sold')
  assert.equal(mintCta({ minted: 1000, maxSupply: 1000, publicStart: 1, allowlist: false }), 'Sold out')
  assert.equal(mintCta({ minted: 12, maxSupply: 1000, publicStart: 1, allowlist: false }), 'Mint')
})
