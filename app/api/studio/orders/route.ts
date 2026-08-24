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
import { reviveOrder } from '@/lib/port/listings'
import {
  COLLECTION_SET,
  ORDER_KEY,
  dropOrder,
  getStoredOrder,
  recordActivity,
  syncCollection,
  type StoredOrder,
} from '@/lib/port/market'

export const dynamic = 'force-dynamic'

/** Orders self-expire; endTime is authoritative on-chain, this just stops KV growing forever. */
const MAX_TTL_SEC = 60 * 60 * 24 * 30

function client() {
  return arcPublicClient()
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

  // One live listing per token in the book. Older signatures stay fillable until the seller
  // cancels them on-chain; the UI cancels before replacing.
  try {
    const hashes = ((await kv.smembers(COLLECTION_SET(offer.token))) as string[]) || []
    const others = (
      await Promise.all(hashes.filter((h) => h.toLowerCase() !== orderHash.toLowerCase()).map((h) => kv.get<StoredOrder>(ORDER_KEY(h))))
    ).filter((r): r is StoredOrder => !!r && r.tokenId === row.tokenId)
    await Promise.all(others.map((r) => kv.srem(COLLECTION_SET(offer.token), r.orderHash)))
  } catch {
    /* kv optional */
  }

  await recordActivity({
    type: 'list',
    collection: row.collection,
    tokenId: row.tokenId,
    priceAtomic: row.priceAtomic,
    from: row.offerer,
    orderHash,
    at: Date.now(),
  })
  const { snapshot } = await syncCollection(offer.token)

  return NextResponse.json({ ok: true, orderHash, priceAtomic: row.priceAtomic, ...snapshot })
}

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get('collection') || ''
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }

  try {
    const { listings, snapshot } = await syncCollection(collection)
    const rows = tokenId ? listings.filter((l) => l.tokenId === tokenId) : listings
    return NextResponse.json({ ok: true, listings: rows, ...snapshot })
  } catch {
    return NextResponse.json({ ok: false, error: 'order store unavailable', listings: [] }, { status: 503 })
  }
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    orderHash?: string
    action?: 'filled' | 'cancel'
    txHash?: string
    buyer?: string
  } | null
  const orderHash = (body?.orderHash || '').trim()
  const action = body?.action
  if (!orderHash || (action !== 'filled' && action !== 'cancel')) {
    return NextResponse.json({ ok: false, error: 'orderHash and action required' }, { status: 400 })
  }
  const row = await getStoredOrder(orderHash)
  if (!row) return NextResponse.json({ ok: false, error: 'unknown order' }, { status: 404 })

  let isCancelled = false
  let filled = false
  try {
    const s = (await client().readContract({
      address: SEAPORT_ADDRESS,
      abi: SEAPORT_ABI,
      functionName: 'getOrderStatus',
      args: [row.orderHash],
    })) as [boolean, boolean, bigint, bigint]
    isCancelled = s[1]
    filled = s[3] > 0n && s[2] >= s[3]
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not reach Seaport: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }

  if (action === 'filled' && !filled) {
    return NextResponse.json({ ok: false, error: 'order is not filled on-chain' }, { status: 400 })
  }
  if (action === 'cancel' && !isCancelled && !filled) {
    return NextResponse.json({ ok: false, error: 'order is still live on-chain' }, { status: 400 })
  }

  await recordActivity({
    type: filled ? 'sale' : 'cancel',
    collection: row.collection,
    tokenId: row.tokenId,
    priceAtomic: row.priceAtomic,
    from: row.offerer,
    to: body?.buyer,
    orderHash: row.orderHash,
    txHash: body?.txHash,
    at: Date.now(),
  })
  await dropOrder(row.collection, row.orderHash)
  const { snapshot } = await syncCollection(row.collection)
  return NextResponse.json({ ok: true, ...snapshot })
}
