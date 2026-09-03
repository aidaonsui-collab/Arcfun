/**
 * node --experimental-strip-types --test lib/port/catalog-cache.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectionFromOverlay, isUsablePortSnapshot, matchPortCollection } from './catalog-from-overlay.ts'

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
  assert.equal(c.minted, 100)
  assert.equal(c.maxSupply, 100)
  assert.equal(c.revealed, true)
  assert.equal(matchPortCollection([c], 'eve')?.address, EVE)
  assert.equal(matchPortCollection([c], 'EVE')?.address, EVE)
})
