/**
 * node --test lib/arc-listing-overlay.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyListingMeta } from './arc-listing-overlay.ts'

const row = {
  id: '0xabc',
  poolId: '0xabc',
  coinType: '0xabc',
  name: '89',
  symbol: '89',
  description: '',
  imageUrl: '',
  logoUrl: '',
  twitter: '',
  telegram: '',
  website: '',
  creator: '0x1',
  creatorShort: '0x1',
  creatorFull: '0x1',
  currentPrice: 0,
  realSuiRaised: 0,
  threshold: 0,
  progress: 100,
  isCompleted: true,
  volume1h: 0,
  priceChange24h: 0,
  age: '',
  marketCap: 0,
}

test('empty catalog row picks up KV pfp and x handle', () => {
  const next = applyListingMeta(row, {
    imageUrl: 'https://blob.example/pfp.jpg',
    twitter: 'KashRazzaghi',
  })
  assert.equal(next.imageUrl, 'https://blob.example/pfp.jpg')
  assert.equal(next.logoUrl, 'https://blob.example/pfp.jpg')
  assert.equal(next.twitter, 'KashRazzaghi')
  assert.equal(next.name, '89')
})

test('missing meta leaves the catalog row alone', () => {
  assert.equal(applyListingMeta(row, null).imageUrl, '')
  assert.equal(applyListingMeta(row, undefined).twitter, '')
})
