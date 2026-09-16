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
 * Create is ready only when address + factory are both set. Mainnet USYC + cirBTC
 * token CAs are baked in; both Instant-create against the shared RwaInstantV4Factory
 * by default (Arc 2026-09-16 live assets post). BUIDL / JAAA / JTRSY stay Soon until
 * issuers publish Arc addresses. Permissioned MMFs still need Circle to allowlist the factory / NFPM / locker.
 */
import { isAddress, type Address } from 'viem'

const ZERO = '0x0000000000000000000000000000000000000000'
const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042
const ARC_IS_TESTNET = ARC_CHAIN_ID === 5042002

/** Shared RwaInstantV4Factory. Quote is per-create; one factory serves USYC/BUIDL/CRCL. */
const V4_RWA_FACTORY_DEFAULT = '0x7f4D81281492D3EBc2629826721223451c20a5Ca'

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

export type RwaAssetKind = 'mmf' | 'equity' | 'commodity'

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
  }
}

function sharedRwaV4Factory(): Address | '' {
  return envAddr('NEXT_PUBLIC_ARC_INSTANT_V4_RWA_FACTORY') || (V4_RWA_FACTORY_DEFAULT as Address)
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
      })
    }
  }
  return [...byId.values()]
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

/** Instant USDC starting FDV. cirBTC uses the same dollars, encoded in 8dp at BTC-USD. */
export const INSTANT_TARGET_FDV_USD = 5500

/**
 * Raw launchVirtualQuote for Instant RWA creates.
 * Stables: 5500 * 10^decimals (~$5500 starting FDV, same as Instant USDC / factory default).
 *
 * cirBTC (8dp): seed ~$5500 of cirBTC, not 5_500e6 raw. 5_500e6 is 55 cirBTC (~$4M FDV)
 * because the factory default is a 6dp USDC encoding. Pass `btcUsd` so 5500/spot * 1e8
 * lands in the same ballpark as Argus / Instant USDC. Env override still wins.
 */
export function defaultRwaVirtualQuoteRaw(
  asset: Pick<ArcRwaAsset, 'id' | 'decimals'>,
  opts?: { btcUsd?: number | null },
): bigint {
  const envKey =
    asset.id === 'cirbtc'
      ? 'NEXT_PUBLIC_ARC_RWA_CIRBTC_VIRTUAL_QUOTE'
      : `NEXT_PUBLIC_ARC_RWA_${asset.id.toUpperCase()}_VIRTUAL_QUOTE`
  const raw = (process.env[envKey] || '').trim()
  if (/^\d+$/.test(raw)) return BigInt(raw)
  if (asset.id === 'cirbtc' || asset.decimals === 8) {
    const btc = opts?.btcUsd
    if (btc && btc > 0) {
      const raw8 = Math.round((INSTANT_TARGET_FDV_USD / btc) * 1e8)
      if (raw8 > 0) return BigInt(raw8)
    }
    // ~$5500 at $100k BTC. Never 5_500_000_000n (55 cirBTC ≈ $4M).
    return 5_500_000n
  }
  const dec = asset.decimals > 0 ? asset.decimals : 6
  return 5500n * 10n ** BigInt(dec)
}
