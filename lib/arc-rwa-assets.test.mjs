/**
 * node --experimental-strip-types --test lib/arc-rwa-assets.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('mainnet catalog bakes USYC + cirBTC + XAUM CAs; Instant-create ready via shared factory', async () => {
  const {
    listRwaAssets,
    rwaCreateReady,
    liveRwaQuoteAssets,
    rwaAssetByQuote,
    quoteSymbolForQuote,
    quoteSettlesInUsdc,
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
  const xaum = all.find((a) => a.id === 'xaum')
  assert.ok(xaum)
  assert.equal(xaum.address.toLowerCase(), '0x178b01f61cbea1d2a5581fe1621be607835ec349')
  assert.equal(xaum.decimals, 18)
  assert.equal(xaum.usd, 'spot')
  assert.equal(xaum.usdSpot, 'XAU-USD')
  assert.equal(xaum.permissioned, false)
  assert.equal(xaum.payUsdcSwap, true)
  assert.equal(rwaCreateReady(xaum), true)
  assert.ok(liveRwaQuoteAssets().some((a) => a.id === 'xaum'))
  assert.equal(rwaAssetByQuote(xaum.address)?.id, 'xaum')
  assert.equal(quoteSymbolForQuote(xaum.address), 'XAUM')
  // $3000 at $4000/oz → 0.75 XAUM = 0.75e18 raw (18dp)
  assert.equal(defaultRwaVirtualQuoteRaw(xaum, { spotUsd: 4_000 }), 750_000_000_000_000_000n)
  assert.equal(defaultRwaVirtualQuoteRaw(xaum), 750_000_000_000_000_000n)
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
  assert.equal(defaultRwaVirtualQuoteRaw(cirbtc, { btcUsd: 100_000 }), 3_000_000n)
  assert.equal(defaultRwaVirtualQuoteRaw(cirbtc, { btcUsd: 50_000 }), 6_000_000n)
  // Missing spot: 0.03 cirBTC (~$3k at $100k), not 30 cirBTC.
  assert.equal(defaultRwaVirtualQuoteRaw(cirbtc), 3_000_000n)
  assert.notEqual(defaultRwaVirtualQuoteRaw(cirbtc), 3_000_000_000n)
  const usdcat = all.find((a) => a.id === 'usdcat')
  assert.ok(usdcat)
  assert.equal(usdcat.address.toLowerCase(), '0x8e98a62a995a50eca9979bfa016f91bf36a8f9d9')
  assert.equal(usdcat.symbol, 'USDCAT')
  assert.equal(usdcat.decimals, 18)
  assert.equal(usdcat.permissioned, false)
  assert.equal(usdcat.payUsdcSwap, false)
  assert.equal(usdcat.priceHooks.toLowerCase(), '0xdb0bfde55fea51eaea8f6cc91d5a253c9265a044')
  assert.equal(usdcat.priceFee, 10000)
  assert.equal(quoteSettlesInUsdc(usdcat), true)
  assert.equal(quoteSettlesInUsdc(xaum), true)
  assert.equal(quoteSettlesInUsdc(usyc), false)
  assert.equal(rwaCreateReady(usdcat), true)
  assert.equal(quoteSymbolForQuote(usdcat.address), 'USDCAT')
  assert.notEqual(quoteSymbolForQuote(usdcat.address), 'USDC')
  // $3000 at $0.002 → 1,500,000 tokens, 18dp. No price → 0, not 3000e18.
  assert.equal(defaultRwaVirtualQuoteRaw(usdcat, { spotUsd: 0.002 }), 1_500_000_000_000_000_000_000_000n)
  assert.equal(defaultRwaVirtualQuoteRaw(usdcat), 0n)
  const poll = all.find((a) => a.id === 'poll')
  assert.ok(poll)
  assert.equal(poll.address.toLowerCase(), '0xf76b1d00bd3d63a37246b5f512074e864010e33d')
  assert.equal(poll.symbol, 'POLL')
  assert.equal(poll.decimals, 18)
  assert.equal(poll.kind, 'meme')
  assert.equal(poll.permissioned, false)
  assert.equal(poll.payUsdcSwap, true)
  assert.equal(poll.priceV3Pool.toLowerCase(), '0x80d56586aa2f51661f54c109a58b6391eafdd934')
  assert.equal(poll.pricePoolId, undefined)
  assert.equal(quoteSettlesInUsdc(poll), true)
  assert.equal(rwaCreateReady(poll), true)
  assert.ok(liveRwaQuoteAssets().some((a) => a.id === 'poll'))
  assert.equal(quoteSymbolForQuote(poll.address), 'POLL')
  // $3000 at $0.001 → 3,000,000 POLL, 18dp. No price → 0, not 3000e18.
  assert.equal(defaultRwaVirtualQuoteRaw(poll, { spotUsd: 0.001 }), 3_000_000_000_000_000_000_000_000n)
  assert.equal(defaultRwaVirtualQuoteRaw(poll), 0n)
  // Shared factory alone is ambiguous once multiple RWA quotes are live.
  assert.equal(rwaAssetByFactory(cirbtc.factory), null)
})

test('every catalog quote has an explicit USD policy (no silent USDC 6dp)', async () => {
  const { listRwaAssets, quotePolicyOk, quotePayUsdcSwap, defaultRwaVirtualQuoteRaw, quoteUsesUsdInput } =
    await import('./arc-rwa-assets.ts')
  for (const a of listRwaAssets()) {
    const r = quotePolicyOk(a)
    assert.equal(r.ok, true, r.ok === false ? r.reason : a.id)
  }
  const cirbtc = listRwaAssets().find((a) => a.id === 'cirbtc')
  const usyc = listRwaAssets().find((a) => a.id === 'usyc')
  const crcl = listRwaAssets().find((a) => a.id === 'crcl')
  assert.ok(cirbtc && usyc && crcl)
  assert.equal(cirbtc.usd, 'spot')
  assert.equal(cirbtc.payUsdcSwap, true)
  assert.equal(quotePayUsdcSwap(cirbtc), true)
  assert.equal(quoteUsesUsdInput(cirbtc), true)
  const xaum = listRwaAssets().find((a) => a.id === 'xaum')
  assert.ok(xaum)
  assert.equal(xaum.usd, 'spot')
  assert.equal(xaum.usdSpot, 'XAU-USD')
  assert.equal(quotePayUsdcSwap(xaum), true)
  assert.equal(quoteUsesUsdInput(xaum), true)
  assert.equal(usyc.usd, 'peg')
  assert.equal(quotePayUsdcSwap(usyc), false)
  assert.equal(quoteUsesUsdInput(usyc), true)
  assert.equal(defaultRwaVirtualQuoteRaw(usyc), 3000n * 10n ** 6n)
  assert.equal(crcl.usd, 'none')
  assert.equal(quoteUsesUsdInput(crcl), false)
  // 8dp without usd=spot must not look like USDC 3000e6.
  const fake8 = { ...cirbtc, id: 'wbtc', usd: 'none', usdSpot: undefined, payUsdcSwap: false, decimals: 8 }
  assert.equal(defaultRwaVirtualQuoteRaw(fake8), 3000n * 10n ** 8n)
  assert.notEqual(defaultRwaVirtualQuoteRaw(fake8), 3_000_000_000n)
})

test('spot first-buy policy is dollars in, quote token out, optional USDC swap', async () => {
  const { quotePolicy, quoteUsesUsdInput, quotePayUsdcSwap, usdToQuoteHuman } = await import(
    './arc-rwa-assets.ts'
  )
  const p = quotePolicy({
    usd: 'spot',
    usdSpot: 'BTC-USD',
    payUsdcSwap: true,
    permissioned: false,
  })
  assert.equal(p.usd, 'spot')
  assert.equal(p.payUsdcSwap, true)
  assert.equal(quoteUsesUsdInput({ usd: 'spot', usdSpot: 'BTC-USD', permissioned: false, payUsdcSwap: true }), true)
  assert.equal(quotePayUsdcSwap({ usd: 'spot', usdSpot: 'BTC-USD', permissioned: false, payUsdcSwap: true }), true)
  assert.equal(usdToQuoteHuman(5500, 100_000, 8), '0.055')
  // Permissioned quotes never USDC-swap (USYC).
  assert.equal(
    quotePayUsdcSwap({ usd: 'peg', permissioned: true, payUsdcSwap: true }),
    false,
  )
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
