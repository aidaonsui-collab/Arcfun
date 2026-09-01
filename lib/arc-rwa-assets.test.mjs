/**
 * node --experimental-strip-types --test lib/arc-rwa-assets.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('USYC/BUIDL stay unready on mainnet without factory env', async () => {
  const { listRwaAssets, rwaCreateReady, liveRwaQuoteAssets } = await import('./arc-rwa-assets.ts')
  const all = listRwaAssets()
  assert.ok(all.some((a) => a.id === 'usyc'))
  assert.ok(all.some((a) => a.id === 'buidl'))
  assert.equal(liveRwaQuoteAssets().length, 0)
  for (const a of all) assert.equal(rwaCreateReady(a), false)
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
  assert.equal(live.length, 1)
  assert.equal(live[0].id, 'usyc')
  assert.equal(live[0].symbol, 'USYC')
  assert.equal(
    rwaAssetByFactory('0xd51E6217bb3bC7586866713854Ea75B7BefF1009')?.id,
    'usyc',
  )
  assert.equal(quoteSymbolForFactory('0xd51E6217bb3bC7586866713854Ea75B7BefF1009'), 'USYC')
  assert.equal(rwaInstantFactories().length, 1)
  delete process.env.NEXT_PUBLIC_ARC_RWA_ASSETS
})
