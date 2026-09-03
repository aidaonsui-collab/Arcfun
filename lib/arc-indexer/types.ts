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
  /** Lifetime USD from pool Swap logs. Monotonic. */
  volumeAll?: number
  /** Inclusive lowest block already folded into volumeAll. */
  volumeAllDownTo?: string
  /** Inclusive highest block already folded into volumeAll. */
  volumeAllUpTo?: string
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
  /**
   * First time this offer was observed at remaining === 0, ms epoch. remaining hits 0 whenever
   * ALL free inventory is under an in-flight hard reserve — not just when an offer is genuinely
   * exhausted or cancelled (cancelOffer() does not flip `active` false either, so that field
   * can't distinguish the two cases yet). Cleared the moment remaining is read as > 0 again.
   * Only remove an offer from the index once this has held for OTC_OFFER_ZERO_REMOVE_MS —
   * comfortably past the 30m default reservation TTL — so a live reservation resolving (settle
   * or self-refund) can't get an offer permanently deleted from the discoverable set for a
   * transient zero read. Once removed, nothing re-adds it: the scan cursor has already moved
   * past its OfferCreated block.
   */
  remainingZeroSince?: number
}

export type IndexerState = {
  version: 1
  /** last processed block for factory TokenCreated-style events */
  factoryCursor: string
  /** last processed block for OTC OfferCreated */
  otcCursor: string
  /** unix ms of last empty-book cursor rewind (avoid looping a rescan every minute) */
  otcEmptyRescanAt?: number
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
    /** `jessica:…` when the home-Mac loop is writing; `vercel-cron` otherwise. */
    worker?: string
  }
}

export type IndexerStatus = {
  ok: boolean
  state: IndexerState | null
  tokenCount: number
  otcOfferCount: number
  kvConfigured: boolean
}
