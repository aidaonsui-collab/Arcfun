import { kv } from '@vercel/kv'
import { type Address, type Hex } from 'viem'
import { arcPublicClient } from '@/lib/contracts-arc'
import { SEAPORT_ABI, SEAPORT_ADDRESS } from './seaport'
import type { Listing } from './listings'

const ORDER_KEY = (h: string) => `arcfun:studio:order:${h.toLowerCase()}`
const COLLECTION_SET = (c: string) => `arcfun:studio:orders:${c.toLowerCase()}`
const ACTIVITY_KEY = (c: string) => `arcfun:studio:activity:${c.toLowerCase()}`
const GLOBAL_ACTIVITY_KEY = 'arcfun:studio:activity:all'
const SNAP_KEY = (c: string) => `arcfun:studio:market:${c.toLowerCase()}`
const SEEN_KEY = (hash: string, type: string) => `arcfun:studio:actseen:${hash.toLowerCase()}:${type}`

const ACTIVITY_CAP = 100
const GLOBAL_ACTIVITY_CAP = 80
const DAY_MS = 86_400_000

export type OrderKind = 'listing' | 'offer' | 'collection-offer'

export type StoredOrder = {
  orderHash: Hex
  order: Record<string, unknown>
  signature: Hex
  collection: Address
  tokenId: string
  priceAtomic: string
  offerer: Address
  endTime: string
  createdAt: number
  kind?: OrderKind
}

export type MarketActivity = {
  type: 'list' | 'sale' | 'cancel' | 'offer' | 'mint'
  collection: string
  tokenId: string
  priceAtomic: string
  from: string
  to?: string
  orderHash: string
  txHash?: string
  at: number
}

export type MarketSnapshot = {
  floorUsdc: number | null
  listed: number
  volume24hUsdc: number
  topOfferUsdc: number | null
  updatedAt: number
}

const EMPTY_SNAP: MarketSnapshot = {
  floorUsdc: null,
  listed: 0,
  volume24hUsdc: 0,
  topOfferUsdc: null,
  updatedAt: 0,
}

export function atomicToUsdc(atomic: string | number | bigint): number {
  return Number(atomic) / 1e6
}

export async function getStoredOrder(hash: string): Promise<StoredOrder | null> {
  try {
    return (await kv.get<StoredOrder>(ORDER_KEY(hash))) ?? null
  } catch {
    return null
  }
}

export async function recordActivity(event: MarketActivity): Promise<void> {
  try {
    const seen = SEEN_KEY(event.orderHash, event.type)
    if (await kv.get(seen)) return
    await kv.set(seen, 1, { ex: 60 * 60 * 24 * 40 })
    const payload = JSON.stringify(event)
    await kv.lpush(ACTIVITY_KEY(event.collection), payload)
    await kv.ltrim(ACTIVITY_KEY(event.collection), 0, ACTIVITY_CAP - 1)
    await kv.lpush(GLOBAL_ACTIVITY_KEY, payload)
    await kv.ltrim(GLOBAL_ACTIVITY_KEY, 0, GLOBAL_ACTIVITY_CAP - 1)
  } catch {
    /* kv optional */
  }
}

function parseActivity(raw: unknown[]): MarketActivity[] {
  return raw
    .map((row) => {
      try {
        return (typeof row === 'string' ? JSON.parse(row) : row) as MarketActivity
      } catch {
        return null
      }
    })
    .filter((e): e is MarketActivity => !!e && !!e.type)
}

export async function getActivity(collection: string, tokenId?: string): Promise<MarketActivity[]> {
  try {
    const raw = (await kv.lrange<string>(ACTIVITY_KEY(collection), 0, ACTIVITY_CAP - 1)) || []
    const rows = parseActivity(raw)
    if (!tokenId) return rows
    return rows.filter((e) => e.tokenId === String(tokenId))
  } catch {
    return []
  }
}

export async function getGlobalActivity(limit = 40): Promise<MarketActivity[]> {
  try {
    const n = Math.min(Math.max(1, limit), GLOBAL_ACTIVITY_CAP)
    const raw = (await kv.lrange<string>(GLOBAL_ACTIVITY_KEY, 0, n - 1)) || []
    return parseActivity(raw)
  } catch {
    return []
  }
}

export async function getSnapshot(collection: string): Promise<MarketSnapshot> {
  try {
    const row = await kv.get<MarketSnapshot>(SNAP_KEY(collection))
    if (row) return row
  } catch {
    /* kv optional */
  }
  return EMPTY_SNAP
}

export async function getSnapshots(addresses: string[]): Promise<Map<string, MarketSnapshot>> {
  const out = new Map<string, MarketSnapshot>()
  if (addresses.length === 0) return out
  try {
    const rows = (await kv.mget(...addresses.map((a) => SNAP_KEY(a)))) as (MarketSnapshot | null)[]
    addresses.forEach((a, i) => {
      out.set(a.toLowerCase(), rows?.[i] || EMPTY_SNAP)
    })
  } catch {
    for (const a of addresses) out.set(a.toLowerCase(), EMPTY_SNAP)
  }
  return out
}

function kindOf(r: StoredOrder | Listing): OrderKind {
  if ('kind' in r && r.kind) return r.kind
  return 'listing'
}

async function writeSnapshot(collection: string, live: Listing[]): Promise<MarketSnapshot> {
  const listings = live.filter((l) => kindOf(l) === 'listing')
  const offers = live.filter((l) => kindOf(l) !== 'listing')
  const prices = listings.map((l) => Number(l.priceAtomic)).filter((n) => Number.isFinite(n) && n > 0)
  const bids = offers.map((l) => Number(l.priceAtomic)).filter((n) => Number.isFinite(n) && n > 0)
  const activity = await getActivity(collection)
  const cutoff = Date.now() - DAY_MS
  const volume24hUsdc = activity
    .filter((e) => e.type === 'sale' && e.at >= cutoff)
    .reduce((s, e) => s + atomicToUsdc(e.priceAtomic), 0)
  const snap: MarketSnapshot = {
    floorUsdc: prices.length ? Math.min(...prices) / 1e6 : null,
    listed: listings.length,
    volume24hUsdc,
    topOfferUsdc: bids.length ? Math.max(...bids) / 1e6 : null,
    updatedAt: Date.now(),
  }
  try {
    await kv.set(SNAP_KEY(collection), snap)
  } catch {
    /* kv optional */
  }
  return snap
}

function toListing(r: StoredOrder): Listing {
  return {
    orderHash: r.orderHash,
    order: r.order,
    signature: r.signature,
    collection: r.collection,
    tokenId: r.tokenId,
    priceAtomic: r.priceAtomic,
    offerer: r.offerer,
    endTime: r.endTime,
    kind: r.kind || 'listing',
  }
}

/** Drop dead orders, record fills/cancels, refresh floor / listed / 24h vol. */
export async function syncCollection(collection: string): Promise<{ listings: Listing[]; snapshot: MarketSnapshot }> {
  let hashes: string[] = []
  try {
    hashes = ((await kv.smembers(COLLECTION_SET(collection))) as string[]) || []
  } catch {
    return { listings: [], snapshot: await getSnapshot(collection) }
  }
  if (hashes.length === 0) {
    const snapshot = await writeSnapshot(collection, [])
    return { listings: [], snapshot }
  }

  const rows = (await Promise.all(hashes.map((h) => kv.get<StoredOrder>(ORDER_KEY(h))))).filter(
    (r): r is StoredOrder => !!r,
  )
  const now = Math.floor(Date.now() / 1000)
  const stillTimed = rows.filter((r) => Number(r.endTime) > now)
  const expired = rows.filter((r) => Number(r.endTime) <= now)

  type OrderStatusHit =
    | { status: 'success'; result: [boolean, boolean, bigint, bigint] }
    | { status: 'failure'; result?: undefined }
  let statuses: OrderStatusHit[] | null = null
  if (stillTimed.length > 0) {
    try {
      statuses = (await arcPublicClient().multicall({
        allowFailure: true,
        contracts: stillTimed.map((r) => ({
          address: SEAPORT_ADDRESS,
          abi: SEAPORT_ABI,
          functionName: 'getOrderStatus' as const,
          args: [r.orderHash] as const,
        })),
      })) as OrderStatusHit[]
    } catch {
      statuses = null
    }
  }

  const live: Listing[] = []
  const drop: string[] = expired.map((r) => r.orderHash)
  const sales: StoredOrder[] = []
  const cancels: StoredOrder[] = []

  stillTimed.forEach((r, i) => {
    const s = statuses?.[i]
    if (s && s.status === 'success') {
      const [, isCancelled, totalFilled, totalSize] = s.result as [boolean, boolean, bigint, bigint]
      if (isCancelled) {
        drop.push(r.orderHash)
        cancels.push(r)
        return
      }
      if (totalSize > 0n && totalFilled >= totalSize) {
        drop.push(r.orderHash)
        sales.push(r)
        return
      }
    }
    live.push(toListing(r))
  })

  if (drop.length) {
    try {
      await Promise.all(drop.map((h) => kv.srem(COLLECTION_SET(collection), h)))
    } catch {
      /* kv optional */
    }
  }

  await Promise.all([
    ...sales.map((r) =>
      recordActivity({
        type: 'sale',
        collection: r.collection,
        tokenId: r.tokenId,
        priceAtomic: r.priceAtomic,
        from: r.offerer,
        orderHash: r.orderHash,
        at: Date.now(),
      }),
    ),
    ...cancels.map((r) =>
      recordActivity({
        type: 'cancel',
        collection: r.collection,
        tokenId: r.tokenId,
        priceAtomic: r.priceAtomic,
        from: r.offerer,
        orderHash: r.orderHash,
        at: Date.now(),
      }),
    ),
  ])

  live.sort((a, b) => Number(BigInt(a.priceAtomic) - BigInt(b.priceAtomic)))
  const snapshot = await writeSnapshot(collection, live)
  return { listings: live, snapshot }
}

export async function dropOrder(collection: string, orderHash: string): Promise<void> {
  try {
    await kv.srem(COLLECTION_SET(collection), orderHash)
  } catch {
    /* kv optional */
  }
}

export { ORDER_KEY, COLLECTION_SET }
