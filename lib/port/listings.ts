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
