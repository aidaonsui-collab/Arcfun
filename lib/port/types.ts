import { timeUntil } from './format'

export type Trait = { type: string; value: string }

export type Collection = {
  address: string
  slug: string
  name: string
  symbol: string
  description: string
  image: string
  banner: string
  creator: string
  creatorName?: string
  creatorRewardsWallet: string
  maxSupply: number
  maxPerWallet: number
  mintPriceUsdc: number
  publicStart: number
  allowlist: boolean
  allowlistStart: number
  allowlistEnd: number
  revealed: boolean
  royalty: number
  minted: number
  owners: number
  /** Lowest live listing in USDC. Null when nothing is listed. */
  floorUsdc?: number | null
  listed?: number
  volume24hUsdc?: number
  topOfferUsdc?: number | null
  twitter?: string
  telegram?: string
  website?: string
  originToken?: string
  originSymbol?: string
}

export type NftItem = {
  collection: string
  id: number
  name: string
  image: string
  owner: string
  traits: Trait[]
  minted?: boolean
  listPriceUsdc?: number
}

export const CREATE_FEE_USDC = 0.1
export const PLATFORM_FEE = 0.05
export const CREATOR_SHARE = 0.95
/** Must match ArcNft721.MAX_MINT_PER_TX. */
export const MAX_MINT_PER_TX = 20
/** Must match ArcNft721.MAX_OWNER_MINT_PER_TX. */
export const MAX_OWNER_MINT_PER_TX = 50

export function allowlistWindowLive(c: Collection): boolean {
  if (!c.allowlist) return false
  const now = Date.now()
  if (c.allowlistStart && now < c.allowlistStart) return false
  if (c.allowlistEnd && now >= c.allowlistEnd) return false
  return true
}

export function publicMintLive(c: Collection): boolean {
  return c.publicStart > 0 && Date.now() >= c.publicStart
}

export function collectionStatus(c: Collection): 'live' | 'soon' | 'sold' {
  if (c.minted >= c.maxSupply) return 'sold'
  if (publicMintLive(c) || allowlistWindowLive(c)) return 'live'
  return 'soon'
}

export function mintCta(c: Collection): string {
  const status = collectionStatus(c)
  if (status === 'sold') return 'Sold out'
  if (publicMintLive(c)) return 'Mint'
  if (allowlistWindowLive(c)) return 'Allowlist mint'
  if (c.allowlist && c.allowlistStart > Date.now()) return `Allowlist in ${timeUntil(c.allowlistStart)}`
  if (c.publicStart > Date.now()) return `Starts in ${timeUntil(c.publicStart)}`
  return 'Mint'
}
