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

/** Active listings for a collection (optionally one token). Never throws — no listings is normal. */
export async function fetchListings(collection: string, tokenId?: number): Promise<Listing[]> {
  try {
    const q = new URLSearchParams({ collection })
    if (tokenId != null) q.set('tokenId', String(tokenId))
    const res = await fetch(`/api/studio/orders?${q}`, { cache: 'no-store' })
    if (!res.ok) return []
    const j = (await res.json()) as { listings?: Listing[] }
    return j.listings ?? []
  } catch {
    return []
  }
}

export function withListPrices(items: NftItem[], listings: Listing[]): NftItem[] {
  const map = new Map(listings.map((l) => [l.tokenId, atomicToUsdc(l.priceAtomic)]))
  return items.map((item) => {
    const price = map.get(String(item.id))
    return price != null ? { ...item, listPriceUsdc: price } : item
  })
}

export async function fetchActivity(collection: string, tokenId?: number) {
  try {
    const q = new URLSearchParams({ collection })
    if (tokenId != null) q.set('tokenId', String(tokenId))
    const res = await fetch(`/api/studio/activity?${q}`, { cache: 'no-store' })
    if (!res.ok) return []
    const j = (await res.json()) as { activity?: import('./market').MarketActivity[] }
    return j.activity ?? []
  } catch {
    return []
  }
}
