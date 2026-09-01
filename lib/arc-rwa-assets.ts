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
 * Create is ready only when address + factory are both set. Token-only (Circle
 * published USYC / a tokenized CRCL share, we have not deployed Instant against
 * it) stays Soon.
 * Permissioned MMFs still need Circle to allowlist the factory / NFPM / locker.
 */
import { isAddress, type Address } from 'viem'

const ZERO = '0x0000000000000000000000000000000000000000'
const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042
const ARC_IS_TESTNET = ARC_CHAIN_ID === 5042002

/** Official Circle USYC on Arc Testnet (docs.arc.io / developers.circle.com). */
const USYC_TESTNET = {
  address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
  entitlements: '0xcc205224862c7641930c87679e98999d23c26113',
  oracle: '0x52b56c7642E71dc54714d879127d97cd0B3D4581',
  teller: '0x9fdF14c5B14173D74C08Af27AebFf39240dC105A',
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

function builtinCatalog(): ArcRwaAsset[] {
  const usycAddr =
    envAddr('NEXT_PUBLIC_ARC_RWA_USYC') ||
    (ARC_IS_TESTNET ? (USYC_TESTNET.address as Address) : '')
  const usycFactory = envAddr('NEXT_PUBLIC_ARC_RWA_USYC_FACTORY')
  const usycEnabled = envFlag('NEXT_PUBLIC_ARC_RWA_USYC_ENABLED')
  const buidlAddr = envAddr('NEXT_PUBLIC_ARC_RWA_BUIDL')
  const buidlFactory = envAddr('NEXT_PUBLIC_ARC_RWA_BUIDL_FACTORY')
  const buidlEnabled = envFlag('NEXT_PUBLIC_ARC_RWA_BUIDL_ENABLED')
  const crclAddr = envAddr('NEXT_PUBLIC_ARC_RWA_CRCL')
  const crclFactory = envAddr('NEXT_PUBLIC_ARC_RWA_CRCL_FACTORY')
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
      navOracle: envAddr('NEXT_PUBLIC_ARC_RWA_USYC_ORACLE') || (ARC_IS_TESTNET ? USYC_TESTNET.oracle : ''),
      entitlements:
        envAddr('NEXT_PUBLIC_ARC_RWA_USYC_ENTITLEMENTS') ||
        (ARC_IS_TESTNET ? USYC_TESTNET.entitlements : ''),
      chainId: ARC_CHAIN_ID,
      enabled: usycEnabled ?? Boolean(usycFactory),
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
      enabled: buidlEnabled ?? Boolean(buidlFactory),
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
      enabled: crclEnabled ?? Boolean(crclFactory),
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
  return liveRwaQuoteAssets()
    .map((a) => a.factory)
    .filter((f): f is Address => Boolean(asAddr(f)))
}

export function rwaAssetByFactory(factory: string | null | undefined): ArcRwaAsset | null {
  const f = (factory || '').toLowerCase()
  if (!f || f === ZERO) return null
  return listRwaAssets().find((a) => a.factory && a.factory.toLowerCase() === f) || null
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
