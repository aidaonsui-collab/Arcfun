/**
 * node --experimental-strip-types --test lib/arc-rwa-assets.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('mainnet catalog bakes USYC + cirBTC CAs; both Instant-create ready via shared factory', async () => {
  const {
    listRwaAssets,
    rwaCreateReady,
    liveRwaQuoteAssets,
    rwaAssetByQuote,
    quoteSymbolForQuote,
    defaultRwaVirtualQuoteRaw,
    rwaAssetByFactory,
  } = await import('./arc-rwa-assets.ts')
  const all = listRwaAssets()
  const usyc = all.find((a) => a.id === 'usyc')
  const cirbtc = all.find((a) => a.id === 'cirbtc')
  assert.ok(usyc)
  assert.equal(usyc.address.toLowerCase(), '0x8a5d989bbb96929f689b0200f435f53da42bf490')
  assert.equal(usyc.entitlements?.toLowerCase(), '0xb69ecb156dc0028198028c501340d5367845ca72')
  assert.ok(cirbtc)
  assert.equal(cirbtc.address.toLowerCase(), '0x171a4217b86a807a64eb94757db6849fb4bdbaa0')
  assert.equal(cirbtc.decimals, 8)
  assert.ok(all.some((a) => a.id === 'buidl'))
  assert.ok(all.some((a) => a.id === 'jaaa'))
  assert.ok(all.some((a) => a.id === 'jtrsy'))
  assert.ok(all.some((a) => a.id === 'crcl' && a.symbol === 'CRCL' && a.kind === 'equity'))
  assert.equal(rwaCreateReady(usyc), true)
  assert.equal(rwaCreateReady(cirbtc), true)
  assert.ok(liveRwaQuoteAssets().some((a) => a.id === 'usyc'))
  assert.ok(liveRwaQuoteAssets().some((a) => a.id === 'cirbtc'))
  assert.equal(rwaAssetByQuote(cirbtc.address)?.id, 'cirbtc')
  assert.equal(quoteSymbolForQuote(cirbtc.address), 'cirBTC')
  assert.equal(defaultRwaVirtualQuoteRaw(cirbtc), 7_250_000n)
  // Shared factory alone is ambiguous once both USYC + cirBTC are live.
  assert.equal(rwaAssetByFactory(cirbtc.factory), null)
})

test('JSON overlay + factory makes create ready', async () => {
  process.env.NEXT_PUBLIC_ARC_RWA_ASSETS = JSON.stringify([
    {
      id: 'usyc',
      address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
      factory: '0xd51E6217bb3bC7586866713854Ea75B7BefF1009',
      locker: '0x84F486d7254aEDc89986bce392771D88bf5828EA',
      decimals: 6,
    },
  ])
  const { liveRwaQuoteAssets, rwaAssetByFactory, quoteSymbolForFactory, rwaInstantFactories } =
    await import('./arc-rwa-assets.ts')
  const live = liveRwaQuoteAssets()
  assert.ok(live.some((a) => a.id === 'usyc'))
  assert.equal(
    rwaAssetByFactory('0xd51E6217bb3bC7586866713854Ea75B7BefF1009')?.id,
    'usyc',
  )
  assert.equal(quoteSymbolForFactory('0xd51E6217bb3bC7586866713854Ea75B7BefF1009'), 'USYC')
  assert.ok(rwaInstantFactories().length >= 1)
  delete process.env.NEXT_PUBLIC_ARC_RWA_ASSETS
})
