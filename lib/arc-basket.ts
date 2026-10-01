/**
 * xStocks basket pairs. A share vault holds a fixed stock recipe. The share is the
 * Instant quote on the live RWA factory. Seed stays disabled until that factory
 * is set and each leg can be pulled.
 */
import { getAddress, isAddress, parseUnits, type Address } from 'viem'
import { INSTANT_TARGET_FDV_USD, sharedRwaV4Factory, type ArcRwaAsset } from '@/lib/arc-rwa-assets'

export const BASKET_STORAGE_KEY = 'eve.baskets.v1'

/**
 * xStocks legs (Backed / xstocks.fi). No xStock has an Arc mainnet contract yet, so every
 * address is null and no leg can be seeded. Fill an address only from an official xStocks
 * Arc deployment. AMD has no xStock in the announced list, so it is dropped.
 */
export const XSTOCK_LEGS: readonly {
  symbol: string
  xSymbol: string
  address: Address | null
  logo: string
}[] = [
  { symbol: 'CRCL', xSymbol: 'CRCLx', address: null, logo: '/marks/stocks/crcl.svg' },
  { symbol: 'NVDA', xSymbol: 'NVDAx', address: null, logo: '/marks/stocks/nvda.svg' },
  { symbol: 'AAPL', xSymbol: 'AAPLx', address: null, logo: '/marks/stocks/aapl.svg' },
  { symbol: 'MSFT', xSymbol: 'MSFTx', address: null, logo: '/marks/stocks/msft.svg' },
  { symbol: 'GOOGL', xSymbol: 'GOOGLx', address: null, logo: '/marks/stocks/googl.svg' },
  { symbol: 'AMZN', xSymbol: 'AMZNx', address: null, logo: '/marks/stocks/amzn.svg' },
  { symbol: 'META', xSymbol: 'METAx', address: null, logo: '/marks/stocks/meta.svg' },
  { symbol: 'TSLA', xSymbol: 'TSLAx', address: null, logo: '/marks/stocks/tsla.svg' },
  { symbol: 'COIN', xSymbol: 'COINx', address: null, logo: '/marks/stocks/coin.png' },
  { symbol: 'SPY', xSymbol: 'SPYx', address: null, logo: '/marks/stocks/spy.svg' },
]

export type BasketLegInput = {
  symbol: string
  address: Address
  /** Whole tokens of this leg inside one share. */
  tokensPerShare: string
  decimals: number
}

export type SavedBasket = {
  id: string
  symbol: string
  name: string
  share: Address
  vault: Address
  usdPerShare: number
  legs: { symbol: string; address: Address; tokensPerShare: string; decimals: number }[]
}

export const BASKET_FACTORY_ABI = [
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'tokens', type: 'address[]' },
      { name: 'units', type: 'uint256[]' },
      { name: 'mintFeeBps', type: 'uint16' },
      { name: 'redeemFeeBps', type: 'uint16' },
    ],
    outputs: [{ name: 'vault', type: 'address' }],
  },
  {
    type: 'event',
    name: 'VaultCreated',
    inputs: [
      { name: 'vault', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'symbol', type: 'string', indexed: false },
    ],
  },
] as const

export const PROTOCOL_MINT_FEE_BPS = 35n
export const MAX_OWNER_FEE_BPS = 100

export const BASKET_VAULT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const

function ceilDiv(a: bigint, d: bigint): bigint {
  if (a === 0n) return 0n
  return (a + d - 1n) / d
}

/** Tokens of one leg a mint must pull: backing rounded up, plus owner and protocol fees. */
export function mintLegCost(units: bigint, shares: bigint, ownerFeeBps: number): bigint {
  const base = ceilDiv(shares * units, 10n ** 18n)
  const owner = ceilDiv(base * BigInt(ownerFeeBps), 10_000n)
  const protocol = ceilDiv(base * PROTOCOL_MINT_FEE_BPS, 10_000n)
  return base + owner + protocol
}

export function basketFactoryAddress(): Address | '' {
  const v = (process.env.NEXT_PUBLIC_ARC_BASKET_FACTORY || '').trim()
  return isAddress(v) ? (getAddress(v) as Address) : ''
}

export function isBasketQuoteId(id: string | null | undefined): boolean {
  return (id || '').toLowerCase().startsWith('basket:')
}

export function basketQuoteId(share: string): string {
  return `basket:${share.toLowerCase()}`
}

export function loadBaskets(): SavedBasket[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(BASKET_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedBasket[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((b) => b && isAddress(b.share) && isAddress(b.vault) && b.usdPerShare > 0)
  } catch {
    return []
  }
}

export function saveBasket(row: SavedBasket) {
  const all = loadBaskets().filter((b) => b.id !== row.id)
  all.unshift(row)
  window.localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify(all.slice(0, 20)))
}

export function basketToAsset(row: SavedBasket): ArcRwaAsset {
  const factory = sharedRwaV4Factory()
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    kind: 'equity',
    address: row.share,
    decimals: 18,
    factory,
    locker: '',
    permissioned: false,
    chainId: Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042,
    enabled: Boolean(factory && row.share),
    usd: 'none',
  }
}

/** Opening virtual quote so FDV is about $3,000 at `usdPerShare`. */
export function basketVirtualQuoteRaw(id: string): bigint {
  const row = loadBaskets().find((b) => b.id === id.toLowerCase())
  if (!row || !(row.usdPerShare > 0)) return 0n
  const micro = Math.round(row.usdPerShare * 1_000_000)
  if (micro <= 0) return 0n
  return (BigInt(INSTANT_TARGET_FDV_USD) * 10n ** 18n * 1_000_000n) / BigInt(micro)
}

export function unitsPerShare(tokensPerShare: string, decimals: number): bigint {
  const n = Number(tokensPerShare)
  if (!(n > 0) || !Number.isFinite(n)) return 0n
  return parseUnits(tokensPerShare, decimals)
}
