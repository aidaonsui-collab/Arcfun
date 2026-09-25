/**
 * Plug-and-play RWA quote assets for Instant creates.
 *
 * InstantErc20QuoteFactory has an immutable QUOTE. The live pad factory is USDC.
 * A TOKEN/USYC (or BUIDL) launch is a *new* Instant factory deployed with that
 * quote — same ABI, same create tx. This file is the only place to turn that on:
 *
 *   NEXT_PUBLIC_ARC_RWA_USYC=0x…
 *   NEXT_PUBLIC_ARC_RWA_USYC_FACTORY=0x…
 *   NEXT_PUBLIC_ARC_RWA_USYC_LOCKER=0x…   # optional; defaults to current Instant locker
 *
 * or a JSON overlay for anything not in the built-in catalog:
 *
 *   NEXT_PUBLIC_ARC_RWA_ASSETS=[{"id":"usyc","symbol":"USYC","address":"0x…","factory":"0x…","decimals":6}]
 *
 * Create is ready only when address + factory are both set. Mainnet USYC + cirBTC + XAUM
 * token CAs are baked in; Instant-create against the shared RwaInstantV4Factory
 * by default (Arc 2026-09-16 live assets post; XAUM 2026-09-18). BUIDL / JAAA / JTRSY stay Soon until
 * issuers publish Arc addresses. Permissioned MMFs still need Circle to allowlist the factory / NFPM / locker.
 */
import { isAddress, type Address } from 'viem'

const ZERO = '0x0000000000000000000000000000000000000000'
const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042
const ARC_IS_TESTNET = ARC_CHAIN_ID === 5042002

/** Shared RwaInstantV4Factory. Quote is per-create; one factory serves USYC/BUIDL/CRCL. */
const V4_RWA_FACTORY_DEFAULT = '0x3489E76510238ef57Ee9d18005a6Fb110f17912D'

/** Official Circle USYC on Arc Testnet (docs.arc.io / developers.circle.com). */
const USYC_TESTNET = {
  address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
  entitlements: '0xcc205224862c7641930c87679e98999d23c26113',
  oracle: '0x52b56c7642E71dc54714d879127d97cd0B3D4581',
  teller: '0x9fdF14c5B14173D74C08Af27AebFf39240dC105A',
} as const

/** Official Circle USYC on Arc Mainnet (developers.circle.com / docs.arc.io, 2026-09-16). */
const USYC_MAINNET = {
  address: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
  entitlements: '0xb69ecb156Dc0028198028c501340d5367845ca72',
  oracle: '0x4BC8d5aCD3d040d2903dD9C5B7048520c6ff537A',
  teller: '0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b',
} as const

/** Circle Wrapped Bitcoin on Arc Mainnet (developers.circle.com/assets/cirbtc-contract-addresses). */
const CIRBTC_MAINNET = {
  address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  decimals: 8,
} as const

/** Matrixdock Gold (XAUM) on Arc Mainnet — 1 XAUM ≈ 1 troy oz gold. */
const XAUM_MAINNET = {
  address: '0x178b01f61CBeA1D2a5581Fe1621Be607835EC349',
  decimals: 18,
} as const

/**
 * UpSideDownCat on Arc mainnet. On-chain symbol is USDC; the pad calls it USDCAT
 * so it never shares a label with Circle USDC (6dp). 18 decimals. Its liquid book
 * is the Argus v4 pool quoted in real USDC (token is currency1).
 */
const USDCAT_MAINNET = {
  address: '0x8E98A62a995A50eca9979bfa016f91bf36A8F9D9',
  decimals: 18,
  pricePoolId: '0x54d5fe8ee7a9546ce74ebe06c1d040defb7757410a627d4793d62a77eaaae4bf',
  priceTokenIsCurrency0: false,
  priceFee: 10000,
  priceTickSpacing: 200,
  priceHooks: '0xDb0BFde55FeA51eAea8F6cc91D5A253c9265a044',
} as const

export type RwaAssetKind = 'mmf' | 'equity' | 'commodity' | 'meme'

/** USD source for FDV, tape, and first-buy. Required on every catalog row. */
export type QuoteUsdMode = 'peg' | 'spot' | 'none'
export type QuoteUsdSpot = 'BTC-USD' | 'XAU-USD'

export const QUOTE_USD_SPOTS: readonly QuoteUsdSpot[] = ['BTC-USD', 'XAU-USD']

export interface ArcRwaAsset {
  id: string
  symbol: string
  name: string
  kind: RwaAssetKind
  /** Issuer token. Empty until they publish a mainnet address. */
  address: Address | typeof ZERO | ''
  decimals: number
  /** InstantErc20QuoteFactory with QUOTE = this token. Empty until we deploy one. */
  factory: Address | typeof ZERO | ''
  locker: Address | typeof ZERO | ''
  permissioned: boolean
  navOracle?: string
  entitlements?: string
  chainId: number
  /** Extra kill. Default on once address+factory are set. */
  enabled: boolean
  /**
   * How this quote maps to USD. Never infer from decimals (that is how cirBTC
   * inherited 5500e6 and launched at ~$4M FDV).
   * - peg: 1 token ≈ $1. Virtual quote = 3000 * 10^decimals. First-buy UI is dollars.
   * - spot: USD from `usdSpot`. Virtual quote = 3000/spot * 10^decimals. First-buy UI is dollars.
   * - none: quote units only. Never label the field as USD.
   */
  usd: QuoteUsdMode
  usdSpot?: QuoteUsdSpot
  /**
   * v4 pool id of this token's own USDC book. Spot USD comes from slot0, not Coinbase.
   * Mutually exclusive with usdSpot.
   */
  pricePoolId?: `0x${string}`
  /** True when this token is currency0 in pricePoolId. */
  priceTokenIsCurrency0?: boolean
  /** Uniswap v4 fee of the quote/USDC pool (hundredths of a bip). */
  priceFee?: number
  priceTickSpacing?: number
  priceHooks?: Address
  /**
   * Create first-buy may pay USDC and swap into this quote when the wallet is short.
   * Instant still pulls the quote token. Only for permissionless quotes with a USDC book.
   */
  payUsdcSwap?: boolean
}

function envAddr(key: string): Address | '' {
  const v = (process.env[key] || '').trim()
  if (v && isAddress(v)) return v as Address
  return ''
}

function envFlag(key: string): boolean | null {
  const v = (process.env[key] || '').trim()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return null
}

function asAddr(v: string | undefined | null): Address | '' {
  const s = (v || '').trim()
  return s && isAddress(s) ? (s as Address) : ''
}

function parseOverlay(): Partial<ArcRwaAsset>[] {
  const raw = (process.env.NEXT_PUBLIC_ARC_RWA_ASSETS || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x) => x && typeof x === 'object') as Partial<ArcRwaAsset>[]
  } catch {
    return []
  }
}

function mergeAsset(base: ArcRwaAsset, over?: Partial<ArcRwaAsset>): ArcRwaAsset {
  if (!over) return base
  const address = asAddr(over.address as string) || base.address
  const factory = asAddr(over.factory as string) || base.factory
  const locker = asAddr(over.locker as string) || base.locker
  const enabled =
    typeof over.enabled === 'boolean'
      ? over.enabled
      : base.enabled || Boolean(address && factory)
  return {
    ...base,
    ...over,
    id: base.id,
    address,
    factory,
    locker,
    decimals: Number(over.decimals) > 0 ? Number(over.decimals) : base.decimals,
    enabled,
    chainId: base.chainId,
    usd: over.usd || base.usd,
    usdSpot: over.usdSpot !== undefined ? over.usdSpot : base.usdSpot,
    payUsdcSwap: typeof over.payUsdcSwap === 'boolean' ? over.payUsdcSwap : base.payUsdcSwap,
  }
}

export function sharedRwaV4Factory(): Address | '' {
  return envAddr('NEXT_PUBLIC_ARC_INSTANT_V4_RWA_FACTORY') || (V4_RWA_FACTORY_DEFAULT as Address)
}

/** Baskets seeded in this browser. Not part of the built-in catalog. */
let clientBasketQuotes: ArcRwaAsset[] = []

export function setClientBasketQuotes(assets: ArcRwaAsset[]) {
  clientBasketQuotes = assets
}

function builtinCatalog(): ArcRwaAsset[] {
  const sharedFactory = sharedRwaV4Factory()
  const usycAddr =
    envAddr('NEXT_PUBLIC_ARC_RWA_USYC') ||
    (ARC_IS_TESTNET ? (USYC_TESTNET.address as Address) : (USYC_MAINNET.address as Address))
  const usycFactory = envAddr('NEXT_PUBLIC_ARC_RWA_USYC_FACTORY') || sharedFactory
  const usycEnabled = envFlag('NEXT_PUBLIC_ARC_RWA_USYC_ENABLED')
  const buidlAddr = envAddr('NEXT_PUBLIC_ARC_RWA_BUIDL')
  const buidlFactory = envAddr('NEXT_PUBLIC_ARC_RWA_BUIDL_FACTORY') || sharedFactory
  const buidlEnabled = envFlag('NEXT_PUBLIC_ARC_RWA_BUIDL_ENABLED')
  const crclAddr = envAddr('NEXT_PUBLIC_ARC_RWA_CRCL')
  const crclFactory = envAddr('NEXT_PUBLIC_ARC_RWA_CRCL_FACTORY') || sharedFactory
  const crclEnabled = envFlag('NEXT_PUBLIC_ARC_RWA_CRCL_ENABLED')

  return [
    {
      id: 'usyc',
      symbol: 'USYC',
      name: 'US Yield Coin',
      kind: 'mmf',
      address: usycAddr,
      decimals: 6,
      factory: usycFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_USYC_LOCKER'),
      permissioned: true,
      navOracle: envAddr('NEXT_PUBLIC_ARC_RWA_USYC_ORACLE') || (ARC_IS_TESTNET ? USYC_TESTNET.oracle : USYC_MAINNET.oracle),
      entitlements:
        envAddr('NEXT_PUBLIC_ARC_RWA_USYC_ENTITLEMENTS') ||
        (ARC_IS_TESTNET ? USYC_TESTNET.entitlements : USYC_MAINNET.entitlements),
      chainId: ARC_CHAIN_ID,
      enabled: usycEnabled ?? Boolean(usycAddr && usycFactory),
      usd: 'peg',
    },
    {
      id: 'buidl',
      symbol: 'BUIDL',
      name: 'BlackRock USD Institutional Digital Liquidity Fund',
      kind: 'mmf',
      address: buidlAddr,
      decimals: 18,
      factory: buidlFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_BUIDL_LOCKER'),
      permissioned: true,
      chainId: ARC_CHAIN_ID,
      enabled: buidlEnabled ?? Boolean(buidlAddr && buidlFactory),
      usd: 'peg',
    },
    {
      id: 'crcl',
      symbol: 'CRCL',
      name: 'Circle Internet Group (tokenized)',
      kind: 'equity',
      address: crclAddr,
      // Tokenized-stock issuers usually use 18dp. Override with NEXT_PUBLIC_ARC_RWA_CRCL_DECIMALS.
      decimals: Number(process.env.NEXT_PUBLIC_ARC_RWA_CRCL_DECIMALS) > 0
        ? Number(process.env.NEXT_PUBLIC_ARC_RWA_CRCL_DECIMALS)
        : 18,
      factory: crclFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_CRCL_LOCKER'),
      permissioned: true,
      chainId: ARC_CHAIN_ID,
      enabled: crclEnabled ?? Boolean(crclAddr && crclFactory),
      usd: 'none',
    },
    {
      id: 'cirbtc',
      symbol: 'cirBTC',
      name: 'Circle Wrapped Bitcoin',
      kind: 'commodity',
      address:
        envAddr('NEXT_PUBLIC_ARC_RWA_CIRBTC') ||
        (ARC_IS_TESTNET ? '' : (CIRBTC_MAINNET.address as Address)),
      decimals: CIRBTC_MAINNET.decimals,
      // Same shared RwaInstantV4Factory as USYC (quote is per-create). Override with env if needed.
      factory: envAddr('NEXT_PUBLIC_ARC_RWA_CIRBTC_FACTORY') || sharedFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_CIRBTC_LOCKER'),
      permissioned: false,
      chainId: ARC_CHAIN_ID,
      enabled: envFlag('NEXT_PUBLIC_ARC_RWA_CIRBTC_ENABLED') ?? Boolean(
        (envAddr('NEXT_PUBLIC_ARC_RWA_CIRBTC') || (!ARC_IS_TESTNET && CIRBTC_MAINNET.address)) &&
          (envAddr('NEXT_PUBLIC_ARC_RWA_CIRBTC_FACTORY') || sharedFactory),
      ),
      usd: 'spot',
      usdSpot: 'BTC-USD',
      payUsdcSwap: true,
    },
    {
      id: 'xaum',
      symbol: 'XAUM',
      name: 'Matrixdock Gold',
      kind: 'commodity',
      address:
        envAddr('NEXT_PUBLIC_ARC_RWA_XAUM') ||
        (ARC_IS_TESTNET ? '' : (XAUM_MAINNET.address as Address)),
      decimals: XAUM_MAINNET.decimals,
      factory: envAddr('NEXT_PUBLIC_ARC_RWA_XAUM_FACTORY') || sharedFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_XAUM_LOCKER'),
      permissioned: false,
      chainId: ARC_CHAIN_ID,
      enabled: envFlag('NEXT_PUBLIC_ARC_RWA_XAUM_ENABLED') ?? Boolean(
        (envAddr('NEXT_PUBLIC_ARC_RWA_XAUM') || (!ARC_IS_TESTNET && XAUM_MAINNET.address)) &&
          (envAddr('NEXT_PUBLIC_ARC_RWA_XAUM_FACTORY') || sharedFactory),
      ),
      usd: 'spot',
      usdSpot: 'XAU-USD',
      payUsdcSwap: true,
    },
    {
      id: 'usdcat',
      symbol: 'USDCAT',
      name: 'UpSideDownCat',
      kind: 'meme',
      address:
        envAddr('NEXT_PUBLIC_ARC_RWA_USDCAT') ||
        (ARC_IS_TESTNET ? '' : (USDCAT_MAINNET.address as Address)),
      decimals: USDCAT_MAINNET.decimals,
      factory: envAddr('NEXT_PUBLIC_ARC_RWA_USDCAT_FACTORY') || sharedFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_USDCAT_LOCKER'),
      permissioned: false,
      chainId: ARC_CHAIN_ID,
      enabled: envFlag('NEXT_PUBLIC_ARC_RWA_USDCAT_ENABLED') ?? Boolean(
        (envAddr('NEXT_PUBLIC_ARC_RWA_USDCAT') || (!ARC_IS_TESTNET && USDCAT_MAINNET.address)) &&
          (envAddr('NEXT_PUBLIC_ARC_RWA_USDCAT_FACTORY') || sharedFactory),
      ),
      usd: 'spot',
      pricePoolId: USDCAT_MAINNET.pricePoolId,
      priceTokenIsCurrency0: USDCAT_MAINNET.priceTokenIsCurrency0,
      priceFee: USDCAT_MAINNET.priceFee,
      priceTickSpacing: USDCAT_MAINNET.priceTickSpacing,
      priceHooks: USDCAT_MAINNET.priceHooks as Address,
      payUsdcSwap: false,
    },
    {
      id: 'jaaa',
      symbol: 'JAAA',
      name: 'Janus Henderson Anemoy AAA CLO Fund',
      kind: 'mmf',
      address: envAddr('NEXT_PUBLIC_ARC_RWA_JAAA'),
      decimals: 6,
      factory: envAddr('NEXT_PUBLIC_ARC_RWA_JAAA_FACTORY') || sharedFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_JAAA_LOCKER'),
      permissioned: true,
      chainId: ARC_CHAIN_ID,
      enabled: envFlag('NEXT_PUBLIC_ARC_RWA_JAAA_ENABLED') ?? Boolean(
        envAddr('NEXT_PUBLIC_ARC_RWA_JAAA') &&
          (envAddr('NEXT_PUBLIC_ARC_RWA_JAAA_FACTORY') || sharedFactory),
      ),
      usd: 'peg',
    },
    {
      id: 'jtrsy',
      symbol: 'JTRSY',
      name: 'Janus Henderson Anemoy Treasury Fund',
      kind: 'mmf',
      address: envAddr('NEXT_PUBLIC_ARC_RWA_JTRSY'),
      decimals: 6,
      factory: envAddr('NEXT_PUBLIC_ARC_RWA_JTRSY_FACTORY') || sharedFactory,
      locker: envAddr('NEXT_PUBLIC_ARC_RWA_JTRSY_LOCKER'),
      permissioned: true,
      chainId: ARC_CHAIN_ID,
      enabled: envFlag('NEXT_PUBLIC_ARC_RWA_JTRSY_ENABLED') ?? Boolean(
        envAddr('NEXT_PUBLIC_ARC_RWA_JTRSY') &&
          (envAddr('NEXT_PUBLIC_ARC_RWA_JTRSY_FACTORY') || sharedFactory),
      ),
      usd: 'peg',
    },
  ]
}

/** All known RWA quote assets (including not-yet-live). */
export function listRwaAssets(): ArcRwaAsset[] {
  const overlay = parseOverlay()
  const byId = new Map<string, ArcRwaAsset>()
  for (const a of builtinCatalog()) byId.set(a.id, a)
  for (const o of overlay) {
    const id = String(o.id || '').toLowerCase()
    if (!id) continue
    const prev = byId.get(id)
    if (prev) {
      byId.set(id, mergeAsset(prev, o))
    } else {
      const factory = asAddr(o.factory as string)
      const address = asAddr(o.address as string)
      if (!address && !factory) continue
      byId.set(id, {
        id,
        symbol: String(o.symbol || id).toUpperCase(),
        name: String(o.name || o.symbol || id),
        kind: (o.kind as RwaAssetKind) || 'mmf',
        address,
        decimals: Number(o.decimals) > 0 ? Number(o.decimals) : 6,
        factory,
        locker: asAddr(o.locker as string),
        permissioned: o.permissioned !== false,
        navOracle: o.navOracle,
        entitlements: o.entitlements,
        chainId: ARC_CHAIN_ID,
        enabled: typeof o.enabled === 'boolean' ? o.enabled : Boolean(factory),
        usd: o.usd === 'spot' || o.usd === 'peg' || o.usd === 'none' ? o.usd : 'none',
        usdSpot: o.usdSpot,
        payUsdcSwap: o.payUsdcSwap,
      })
    }
  }
  return [...byId.values(), ...clientBasketQuotes]
}

export function rwaCreateReady(a: ArcRwaAsset): boolean {
  return (
    a.enabled &&
    a.chainId === ARC_CHAIN_ID &&
    Boolean(asAddr(a.address)) &&
    Boolean(asAddr(a.factory))
  )
}

export function liveRwaQuoteAssets(): ArcRwaAsset[] {
  return listRwaAssets().filter(rwaCreateReady)
}

export function pendingRwaQuoteAssets(): ArcRwaAsset[] {
  return listRwaAssets().filter((a) => !rwaCreateReady(a))
}

export function rwaInstantFactories(): Address[] {
  const seen = new Set<string>()
  const out: Address[] = []
  for (const a of liveRwaQuoteAssets()) {
    const f = asAddr(a.factory)
    if (!f) continue
    const k = f.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

export function rwaAssetByFactory(factory: string | null | undefined): ArcRwaAsset | null {
  const f = (factory || '').toLowerCase()
  if (!f || f === ZERO) return null
  const matches = listRwaAssets().filter((a) => a.factory && a.factory.toLowerCase() === f)
  // Shared RwaInstantV4Factory serves multiple quotes — factory alone is ambiguous.
  if (matches.length === 1) return matches[0]
  return null
}

export function rwaAssetByQuote(quote: string | null | undefined): ArcRwaAsset | null {
  const q = (quote || '').toLowerCase()
  if (!q || q === ZERO) return null
  return listRwaAssets().find((a) => a.address && a.address.toLowerCase() === q) || null
}

export function rwaAssetById(id: string | null | undefined): ArcRwaAsset | null {
  const k = (id || '').toLowerCase()
  if (!k) return null
  return listRwaAssets().find((a) => a.id === k) || null
}

export function rwaLockerForFactory(factory: string | null | undefined): Address | null {
  const a = rwaAssetByFactory(factory)
  const locker = asAddr(a?.locker)
  return locker || null
}

export function quoteTokenForFactory(factory: string | null | undefined): Address | null {
  const a = rwaAssetByFactory(factory)
  const addr = asAddr(a?.address)
  return addr || null
}

const USDC = '0x3600000000000000000000000000000000000000'

/** Quote-token decimals for Instant tape / first-buy. USDC and unknown → 6. */
export function quoteDecimalsForToken(token: string | null | undefined): number {
  const t = (token || '').toLowerCase()
  if (!t || t === ZERO) return 6
  if (t === USDC) return 6
  const a = listRwaAssets().find((x) => x.address && x.address.toLowerCase() === t)
  return a?.decimals && a.decimals > 0 ? a.decimals : 6
}

export function quoteDecimalsForFactory(factory: string | null | undefined): number {
  const a = rwaAssetByFactory(factory)
  if (a?.decimals && a.decimals > 0) return a.decimals
  return 6
}

export function quoteSymbolForFactory(factory: string | null | undefined): string {
  return rwaAssetByFactory(factory)?.symbol || 'USDC'
}

/** Prefer when the indexer/row knows the per-launch quote (shared RWA factory). */
export function quoteSymbolForQuote(quote: string | null | undefined): string {
  const q = (quote || '').toLowerCase()
  if (!q || q === ZERO) return 'USDC'
  if (q === USDC.toLowerCase()) return 'USDC'
  return rwaAssetByQuote(q)?.symbol || 'USDC'
}

export type QuotePolicy = {
  usd: QuoteUsdMode
  usdSpot: QuoteUsdSpot | null
  payUsdcSwap: boolean
}

/** USDC (no catalog row) is a $1 peg. Catalog rows must set `usd` explicitly. */
export function quotePolicy(asset: Pick<ArcRwaAsset, 'usd' | 'usdSpot' | 'payUsdcSwap' | 'permissioned'> | null | undefined): QuotePolicy {
  if (!asset) return { usd: 'peg', usdSpot: null, payUsdcSwap: false }
  const usd: QuoteUsdMode = asset.usd === 'spot' || asset.usd === 'none' || asset.usd === 'peg' ? asset.usd : 'none'
  const usdSpot = usd === 'spot' ? asset.usdSpot || null : null
  const payUsdcSwap = Boolean(asset.payUsdcSwap) && !asset.permissioned && usd !== 'none'
  return { usd, usdSpot, payUsdcSwap }
}

/** Catalog invariant: no silent USDC 6dp inheritance. */
export function quotePolicyOk(asset: ArcRwaAsset): { ok: true } | { ok: false; reason: string } {
  if (asset.usd !== 'peg' && asset.usd !== 'spot' && asset.usd !== 'none') {
    return { ok: false, reason: `${asset.id}: set usd to peg | spot | none` }
  }
  if (asset.usd === 'spot') {
    const hasFeed = Boolean(asset.usdSpot && QUOTE_USD_SPOTS.includes(asset.usdSpot))
    const hasPool = Boolean(asset.pricePoolId)
    if (hasFeed === hasPool) {
      return {
        ok: false,
        reason: `${asset.id}: usd=spot needs a Coinbase usdSpot or a pricePoolId, not both`,
      }
    }
  }
  if (asset.usd !== 'spot' && (asset.usdSpot || asset.pricePoolId)) {
    return { ok: false, reason: `${asset.id}: usdSpot only valid with usd=spot` }
  }
  if (asset.payUsdcSwap && (asset.permissioned || asset.usd === 'none')) {
    return { ok: false, reason: `${asset.id}: payUsdcSwap is for permissionless USD-input quotes` }
  }
  return { ok: true }
}

export function quoteUsesUsdInput(asset: ArcRwaAsset | null | undefined, quoteId?: string): boolean {
  if ((quoteId || '') === 'usdc') return true
  const p = quotePolicy(asset)
  return p.usd === 'peg' || p.usd === 'spot'
}

export function quotePayUsdcSwap(asset: ArcRwaAsset | null | undefined): boolean {
  return quotePolicy(asset).payUsdcSwap
}

/**
 * Token-page buys and sells for a permissionless custom pair settle in USDC.
 * cirBTC and XAUM hop through their v3 USDC pool. USDCAT hops through its v4 pool.
 * Permissioned quotes stay in the quote token.
 */
export function quoteSettlesInUsdc(asset: ArcRwaAsset | null | undefined): boolean {
  if (!asset || asset.permissioned) return false
  if (asset.payUsdcSwap) return true
  return Boolean(asset.pricePoolId && asset.priceHooks && asset.priceFee && asset.priceTickSpacing)
}

export function quoteChartLabel(symbol: string, asset: ArcRwaAsset | null | undefined): string {
  if (symbol === 'USDC') return 'USDC'
  const p = quotePolicy(asset)
  if (p.usd === 'spot') return 'USD'
  if (p.usd === 'peg') return symbol
  return symbol
}

/** USD per 1 whole quote token. Peg = 1. Spot = live USD. none = 0 (do not fake $). */
export async function quoteUsdMultiplier(quote: string | null | undefined): Promise<number> {
  const q = (quote || '').toLowerCase()
  if (!q || q === ZERO || q === USDC.toLowerCase()) return 1
  const asset = rwaAssetByQuote(q)
  const p = quotePolicy(asset)
  if (p.usd === 'peg') return 1
  if (p.usd === 'spot' && asset?.pricePoolId) {
    const { fetchQuotePoolUsd } = await import('./quote-pool-usd')
    const px = await fetchQuotePoolUsd({
      poolId: asset.pricePoolId,
      tokenIsCurrency0: asset.priceTokenIsCurrency0 === true,
      tokenDecimals: asset.decimals,
    })
    return px && px > 0 ? px : 0
  }
  if (p.usd === 'spot' && p.usdSpot) {
    const { fetchQuoteUsdSpot } = await import('./quote-usd-spot')
    const px = await fetchQuoteUsdSpot(p.usdSpot)
    return px && px > 0 ? px : 0
  }
  return 0
}

export function usdToQuoteHuman(usd: number, usdPerQuote: number, decimals: number): string {
  if (!(usd > 0) || !(usdPerQuote > 0) || !(decimals > 0)) return '0'
  const q = usd / usdPerQuote
  const dp = Math.min(Math.max(0, Math.floor(decimals)), 18)
  const fixed = q.toFixed(dp)
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '') || '0'
}

/** Instant USDC starting FDV. Spot quotes encode the same dollars in native decimals. */
export const INSTANT_TARGET_FDV_USD = 3000

/**
 * Raw launchVirtualQuote for Instant RWA creates.
 * Peg: 3000 * 10^decimals. Spot: 3000/usdPerQuote * 10^decimals.
 * Never use 3000e6 for an 8dp non-peg (that is 30 BTC, ~$3M FDV).
 */
export function defaultRwaVirtualQuoteRaw(
  asset: Pick<
    ArcRwaAsset,
    'id' | 'decimals' | 'usd' | 'usdSpot' | 'payUsdcSwap' | 'permissioned' | 'pricePoolId'
  >,
  opts?: { spotUsd?: number | null; btcUsd?: number | null },
): bigint {
  const envKey = `NEXT_PUBLIC_ARC_RWA_${asset.id.toUpperCase()}_VIRTUAL_QUOTE`
  const raw = (process.env[envKey] || '').trim()
  if (/^\d+$/.test(raw)) return BigInt(raw)
  const dec = asset.decimals > 0 ? asset.decimals : 6
  const p = quotePolicy(asset)
  if (p.usd === 'spot' && asset.pricePoolId) {
    const spot = opts?.spotUsd ?? opts?.btcUsd
    if (!(spot && spot > 0)) return 0n
    // Micro-dollars keep an 18dp meme quote inside integer math (JS Number cannot hold 1e24).
    const micro = BigInt(Math.round(spot * 1_000_000))
    if (micro <= 0n) return 0n
    return (3000n * 10n ** BigInt(dec) * 1_000_000n) / micro
  }
  if (p.usd === 'spot' && p.usdSpot) {
    const spot = opts?.spotUsd ?? opts?.btcUsd
    if (spot && spot > 0) {
      const rawN = Math.round((INSTANT_TARGET_FDV_USD / spot) * 10 ** dec)
      if (rawN > 0) return BigInt(rawN)
    }
    // Fallbacks: $3000 at $100k BTC / $4k XAU. Never 3000e6 for non-6dp.
    const fb = p.usdSpot === 'XAU-USD' ? 4_000n : 100_000n
    return (3000n * 10n ** BigInt(dec)) / fb
  }
  return 3000n * 10n ** BigInt(dec)
}
