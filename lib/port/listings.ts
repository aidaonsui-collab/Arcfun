import type { Address, Hex } from 'viem'
import type { NftItem } from './types'
import { atomicToUsdc } from './market'
import type { OrderComponents } from './seaport'

/** Shape the order-book API returns for an active listing. */
export type Listing = {
  orderHash: string
  order: Record<string, unknown>
  signature: string
  collection: string
  tokenId: string
  priceAtomic: string
  offerer: string
  endTime: string
  kind?: 'listing' | 'offer' | 'collection-offer'
}

/** JSON round-trip gives decimal strings; Seaport needs bigints. */
export function reviveOrder(o: Record<string, unknown>): OrderComponents {
  const big = (v: unknown) => BigInt(String(v))
  const item = (i: Record<string, unknown>) => ({
    itemType: Number(i.itemType),
    token: i.token as Address,
    identifierOrCriteria: big(i.identifierOrCriteria),
    startAmount: big(i.startAmount),
    endAmount: big(i.endAmount),
  })
  return {
    offerer: o.offerer as Address,
    zone: o.zone as Address,
    offer: (o.offer as Record<string, unknown>[]).map(item),
    consideration: (o.consideration as Record<string, unknown>[]).map((i) => ({
      ...item(i),
      recipient: i.recipient as Address,
    })),
    orderType: Number(o.orderType),
    startTime: big(o.startTime),
    endTime: big(o.endTime),
    zoneHash: o.zoneHash as Hex,
    salt: big(o.salt),
    conduitKey: o.conduitKey as Hex,
    counter: big(o.counter),
  }
}

/**
 * Active orders for a collection. Never throws.
 *
 * null = the read failed, keep whatever is on screen. [] = the book is genuinely empty.
 * Collapsing the two makes a rate-limited or degraded read render as an empty market, which
 * reads to a seller as "my listing is gone" while the order is still live on Seaport.
 */
export async function fetchListings(
  collection: string,
  tokenId?: number,
  kind?: Listing['kind'],
): Promise<Listing[] | null> {
  try {
    const q = new URLSearchParams({ collection })
    if (tokenId != null) q.set('tokenId', String(tokenId))
    if (kind) q.set('kind', kind)
    const res = await fetch(`/api/studio/orders?${q}`, { cache: 'no-store' })
    if (!res.ok) return null
    const j = (await res.json()) as { listings?: Listing[] }
    return j.listings ?? []
  } catch {
    return null
  }
}

export function isListing(l: Listing) {
  return (l.kind || 'listing') === 'listing'
}

export function sortByPriceDesc(rows: Listing[]): Listing[] {
  return [...rows].sort((a, b) => Number(BigInt(b.priceAtomic) - BigInt(a.priceAtomic)))
}

export function sortByPriceAsc(rows: Listing[]): Listing[] {
  return [...rows].sort((a, b) => Number(BigInt(a.priceAtomic) - BigInt(b.priceAtomic)))
}

export function withListPrices(items: NftItem[], listings: Listing[]): NftItem[] {
  const map = new Map(
    listings.filter(isListing).map((l) => [l.tokenId, atomicToUsdc(l.priceAtomic)]),
  )
  return items.map((item) => {
    const price = map.get(String(item.id))
    return price != null ? { ...item, listPriceUsdc: price } : item
  })
}

export async function fetchActivity(
  collection?: string,
  tokenId?: number | string,
  signal?: AbortSignal,
) {
  try {
    const q = new URLSearchParams()
    if (collection) q.set('collection', collection)
    if (tokenId != null && tokenId !== '') q.set('tokenId', String(tokenId))
    const path = q.size ? `/api/studio/activity?${q}` : '/api/studio/activity'
    const res = await fetch(path, { cache: 'no-store', signal })
    if (!res.ok) return []
    const j = (await res.json()) as { activity?: import('./market').MarketActivity[] }
    return j.activity ?? []
  } catch {
    return []
  }
}
