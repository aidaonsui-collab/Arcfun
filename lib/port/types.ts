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

export function collectionStatus(c: Collection): 'live' | 'soon' | 'sold' {
  if (c.minted >= c.maxSupply) return 'sold'
  if (c.publicStart > Date.now()) return 'soon'
  return 'live'
}
