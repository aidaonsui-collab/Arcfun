import type { Address, Hex } from 'viem'

export type IndexedLaunchKind = 'instant' | 'reflection' | 'curve' | 'unknown'

export type IndexedToken = {
  token: Address
  creator: Address
  pool: Address
  factory: Address
  kind: IndexedLaunchKind
  /** unix seconds when first indexed / created event */
  createdAt: number
  createdBlock?: number
}

export type IndexedVolume = {
  volume1h: number
  volume6h: number
  volume12h: number
  volume24h: number
  /** last swap ts seen */
  lastTradeAt: number
  updatedAt: number
  /** (last print − print 24h ago) / print 24h ago × 100. First print if younger than 24h. */
  priceChange24h?: number
  /** 5m candle closes for home-rail spark (same buckets as the token chart). */
  sparkCloses?: number[]
}

export type IndexedOtcOffer = {
  offerId: Hex
  maker: Address
  sellerPayment: Address
  premiumBps: number
  /** last known free remaining (USDC 6dp string for JSON safety) */
  remaining: string
  active: boolean
  createdBlock?: number
  updatedAt: number
}

export type IndexerState = {
  version: 1
  /** last processed block for factory TokenCreated-style events */
  factoryCursor: string
  /** last processed block for OTC OfferCreated */
  otcCursor: string
  /** round-robin offset into token list for swap catch-up */
  swapRotate: number
  updatedAt: number
  lastRun?: {
    at: number
    ok: boolean
    ms: number
    factories: number
    otcOffers: number
    swapsTokens: number
    error?: string
  }
}

export type IndexerStatus = {
  ok: boolean
  state: IndexerState | null
  tokenCount: number
  otcOfferCount: number
  kvConfigured: boolean
}
