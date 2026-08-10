/**
 * `PoolToken` shape + hidden-token denylist — trimmed from Robinpad's `lib/tokens.ts` (805 lines
 * covering Sui/RH4663/Monad/Stable catalog fetching) to just what `lib/arc-instant-tokens.ts` and
 * the ArcFun pages need. Perp/RWA/reflection metadata fields from the upstream type are dropped —
 * Arc only ever produces plain Instant meme tokens.
 */
export interface PoolToken {
  id: string
  /** Always 'arc' in this fork — kept as a field (rather than dropped) because
   *  lib/arc-instant-tokens.ts (copied verbatim from Robinpad) stamps it on every pool it builds. */
  chain?: string
  createdAt?: number
  poolId: string
  name: string
  symbol: string
  description: string
  imageUrl: string
  twitter: string
  telegram: string
  website: string
  streamUrl?: string
  creator: string
  currentPrice: number
  realSuiRaised: number
  threshold: number
  progress: number
  isCompleted: boolean
  virtualSuiReserves?: bigint
  virtualTokenReserves?: bigint
  coinType: string
  moonbagsPackageId?: string
  volume1h: number
  priceChange24h: number
  lastTradeAt?: number
  age: string
  creatorShort: string
  creatorFull: string
  logoUrl: string
  marketCap: number
  totalSupply: number
  bondingProgress: number
  /** Instant DEX launch (no bonding curve) — always true for Arc tokens today. */
  instantLaunch?: boolean
  instant?: boolean
  /** Instant Reflection (holder rewards) vs plain Instant Uni V3. */
  reflection?: boolean
  /** Launch product line for badges / filters. */
  launchKind?: 'instant' | 'reflection' | 'curve'
  instantMeta?: {
    uniPool?: string
    positionId?: string
    isMeme?: boolean
    isRwaBacked?: boolean
    isMarginBacked?: boolean
    quote?: 'ETH' | 'ROBIN' | 'USDC'
    dexId?: 0 | 1
  }
  dexVenue?: 'v3' | 'v4'
}

/** True when token was launched via Instant Reflection factory. */
export function isReflectionToken(token: Pick<PoolToken, 'reflection' | 'launchKind' | 'moonbagsPackageId'>): boolean {
  if (token.reflection === true || token.launchKind === 'reflection') return true
  const f = (token.moonbagsPackageId || '').toLowerCase()
  // Default Instant Reflection factory (also set via env at catalog build time).
  return f === '0xa4957e724696b740b323ff3536415bb945e46828'
}

/** Denylist — hide test/spam tokens. New tokens show automatically unless added here. */
export const HIDDEN_TOKENS = new Set<string>([
  '0x233861f8cd3c0ab8599627934eda42d5a8259140', // Darc Coin — legacy-factory smoke-test launch
  '0xfe93ca9f3c7d562490191c31da7c64a3932ce255', // hidden per platform owner request
  '0x8d50581f7c098847ac2cf6992db165ec606e5d76', // hidden per platform owner request
])

/** Case-insensitive match for EVM addresses (0x…). */
export function isHiddenToken(coinType: string): boolean {
  if (HIDDEN_TOKENS.has(coinType)) return true
  if (coinType.startsWith('0x')) return HIDDEN_TOKENS.has(coinType.toLowerCase())
  return false
}
