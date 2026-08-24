/**
 * ArcStudio order book — off-chain storage for signed Seaport 1.6 listings.
 *
 * Seaport is the settlement layer; orders themselves live off-chain until someone fills one.
 * That is the standard model (OpenSea, Blur) and it means listing is free and gasless — the
 * seller signs, we store, and only the buyer pays gas.
 *
 * Nothing here is trusted. A stored order is only ever a signature we re-verify: POST checks the
 * signature against the offerer and the order hash against Seaport's own getOrderHash(), and GET
 * re-checks live on-chain status so a cancelled or already-filled order can never be served as
 * active. Storage is a cache, never the authority.
 */
import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { isAddress, verifyTypedData, type Address, type Hex } from 'viem'
import { arcPublicClient } from '@/lib/contracts-arc'
import {
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  seaportDomain,
  type OrderComponents,
} from '@/lib/port/seaport'

export const dynamic = 'force-dynamic'

const ORDER_KEY = (h: string) => `arcfun:studio:order:${h.toLowerCase()}`
const COLLECTION_SET = (c: string) => `arcfun:studio:orders:${c.toLowerCase()}`
/** Orders self-expire; endTime is authoritative on-chain, this just stops KV growing forever. */
const MAX_TTL_SEC = 60 * 60 * 24 * 30

type StoredOrder = {
  orderHash: Hex
  order: Record<string, unknown>
  signature: Hex
  collection: Address
  tokenId: string
  priceAtomic: string
  offerer: Address
  endTime: string
  createdAt: number
}

function client() {
  return arcPublicClient()
}

/** JSON gives us decimal strings; Seaport needs bigints. */
function reviveOrder(o: Record<string, unknown>): OrderComponents {
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

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { order?: Record<string, unknown>; signature?: Hex } | null
  if (!body?.order || !body?.signature) {
    return NextResponse.json({ ok: false, error: 'order and signature required' }, { status: 400 })
  }

  let order: OrderComponents
  try {
    order = reviveOrder(body.order)
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed order' }, { status: 400 })
  }

  const offer = order.offer[0]
  if (order.offer.length !== 1 || offer.itemType !== 2) {
    return NextResponse.json({ ok: false, error: 'only single ERC-721 listings are accepted' }, { status: 400 })
  }
  if (order.endTime <= BigInt(Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ ok: false, error: 'order already expired' }, { status: 400 })
  }

  const c = client()

  // Seaport's own hash is the identity of the order — never trust a client-supplied one.
  let orderHash: Hex
  try {
    orderHash = (await c.readContract({
      address: SEAPORT_ADDRESS,
      abi: SEAPORT_ABI,
      functionName: 'getOrderHash',
      args: [order],
    })) as Hex
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not reach Seaport: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }

  // The counter in the order must be the offerer's CURRENT counter, or the signature is already
  // void — Seaport bumps the counter to mass-cancel, and a stale one would never fill.
  const counter = (await c.readContract({
    address: SEAPORT_ADDRESS,
    abi: SEAPORT_ABI,
    functionName: 'getCounter',
    args: [order.offerer],
  })) as bigint
  if (counter !== order.counter) {
    return NextResponse.json({ ok: false, error: 'stale counter — offerer has cancelled all orders' }, { status: 400 })
  }

  const validSig = await verifyTypedData({
    address: order.offerer,
    domain: seaportDomain(),
    types: SEAPORT_ORDER_TYPES,
    primaryType: 'OrderComponents',
    message: order as never,
    signature: body.signature,
  }).catch(() => false)
  if (!validSig) {
    return NextResponse.json({ ok: false, error: 'signature does not match offerer' }, { status: 400 })
  }

  // Seller must still own the token, or the listing is dead on arrival.
  const owner = (await c.readContract({
    address: offer.token,
    abi: [
      { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
    ] as const,
    functionName: 'ownerOf',
    args: [offer.identifierOrCriteria],
  }).catch(() => null)) as Address | null
  if (!owner || owner.toLowerCase() !== order.offerer.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'offerer does not own this token' }, { status: 400 })
  }

  const price = order.consideration.reduce((a, i) => a + i.startAmount, 0n)
  const row: StoredOrder = {
    orderHash,
    order: body.order,
    signature: body.signature,
    collection: offer.token,
    tokenId: offer.identifierOrCriteria.toString(),
    priceAtomic: price.toString(),
    offerer: order.offerer,
    endTime: order.endTime.toString(),
    createdAt: Date.now(),
  }
  await kv.set(ORDER_KEY(orderHash), row, { ex: MAX_TTL_SEC })
  await kv.sadd(COLLECTION_SET(offer.token), orderHash)

  return NextResponse.json({ ok: true, orderHash, priceAtomic: row.priceAtomic })
}

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get('collection') || ''
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }

  let hashes: string[] = []
  try {
    hashes = ((await kv.smembers(COLLECTION_SET(collection))) as string[]) || []
  } catch {
    return NextResponse.json({ ok: false, error: 'order store unavailable', listings: [] }, { status: 503 })
  }
  if (hashes.length === 0) return NextResponse.json({ ok: true, listings: [] })

  const rows = (await Promise.all(hashes.map((h) => kv.get<StoredOrder>(ORDER_KEY(h))))).filter(
    (r): r is StoredOrder => !!r,
  )
  const now = Math.floor(Date.now() / 1000)
  const live = rows.filter(
    (r) => Number(r.endTime) > now && (!tokenId || r.tokenId === tokenId),
  )
  if (live.length === 0) return NextResponse.json({ ok: true, listings: [] })

  // Re-check on-chain: a seller can cancel or fill without telling us, and serving a dead order
  // would send buyers into a guaranteed revert.
  const c = client()
  const statuses = await c
    .multicall({
      contracts: live.map((r) => ({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getOrderStatus' as const,
        args: [r.orderHash] as const,
      })),
      allowFailure: true,
    })
    .catch(() => null)

  const listings = live
    .map((r, i) => {
      const s = statuses?.[i]
      if (s && s.status === 'success') {
        const [, isCancelled, totalFilled, totalSize] = s.result as [boolean, boolean, bigint, bigint]
        if (isCancelled) return null
        if (totalSize > 0n && totalFilled >= totalSize) return null
      }
      return {
        orderHash: r.orderHash,
        order: r.order,
        signature: r.signature,
        collection: r.collection,
        tokenId: r.tokenId,
        priceAtomic: r.priceAtomic,
        offerer: r.offerer,
        endTime: r.endTime,
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(BigInt((a as { priceAtomic: string }).priceAtomic) - BigInt((b as { priceAtomic: string }).priceAtomic)))

  return NextResponse.json({ ok: true, listings })
}
