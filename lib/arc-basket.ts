/**
 * Dinari basket pairs. A share vault holds a fixed stock recipe. The share is the
 * Instant quote on the live RWA factory. Seed stays disabled until that factory
 * is set and each leg can be pulled.
 */
import { getAddress, isAddress, parseUnits, type Address } from 'viem'
import { INSTANT_TARGET_FDV_USD, sharedRwaV4Factory, type ArcRwaAsset } from '@/lib/arc-rwa-assets'

export const BASKET_STORAGE_KEY = 'eve.baskets.v1'

export const DINARI_LEGS = [
  { symbol: 'CRCL', address: '0x2eBbD389bf504fA9f0600361ef70C15eb62Cc93B' },
  { symbol: 'NVDA', address: '0x4B16f5251cd4c853f28998809DcA61ccCBcB898B' },
  { symbol: 'AAPL', address: '0xB6b0149009eb78239213b97A960b5c793C03373b' },
  { symbol: 'MSFT', address: '0x1831FdAC7Fcb9271f2E2FfB1bbba965CcAf8136B' },
  { symbol: 'GOOGL', address: '0x7024f993A0781169E064346396c5F6139DC6d98A' },
  { symbol: 'AMZN', address: '0xAbA4a08C36404f6EFf79Dc85b0b4c5172A095504' },
  { symbol: 'META', address: '0x5183EfaBdDA4F872788307B705163982036ba962' },
  { symbol: 'TSLA', address: '0x4193C2B9B176763f48B1eF5266aEd71f6348ba81' },
  { symbol: 'AMD', address: '0x2B7c9A6448576790aa6CE639E4c70BBb32E65c43' },
  { symbol: 'COIN', address: '0x7eE2c4BE439b9571FabC520dE92ad05582492A3D' },
  { symbol: 'SPY', address: '0x82E9e5725dA9050e121D12802fCC302752aBaA1A' },
] as const

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
      { name: 'seedShares', type: 'uint256' },
      { name: 'shareCap', type: 'uint256' },
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

export const BASKET_VAULT_ABI = [
  {
    type: 'function',
    name: 'seed',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

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
