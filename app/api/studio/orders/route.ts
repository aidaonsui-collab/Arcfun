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
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import {
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  ItemType,
  orderKindOf,
  seaportDomain,
  type OrderComponents,
} from '@/lib/port/seaport'
import { reviveOrder, type Listing } from '@/lib/port/listings'
import { assertAcceptedStudioOrder } from '@/lib/port/order-policy'
import { isTxHash, readCancelFromReceipt, readFillFromReceipt } from '@/lib/port/fill'
import { limitOr429 } from '@/lib/rate-limit'
import {
  COLLECTION_SET,
  ORDER_KEY,
  dropOrder,
  fillActivityType,
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
  const limited = await limitOr429(req, 'studio-orders-post', 30, 60, true)
  if (limited) return limited
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
  const consid0 = order.consideration[0]
  if (!offer || !consid0) {
    return NextResponse.json({ ok: false, error: 'empty order' }, { status: 400 })
  }
  const kind = orderKindOf(order)
  const usdc = ARC.USDC.toLowerCase()
  const erc20s = [...order.offer, ...order.consideration].filter((i) => i.itemType === ItemType.ERC20)
  if (erc20s.some((i) => i.token.toLowerCase() !== usdc)) {
    return NextResponse.json({ ok: false, error: 'only Arc USDC' }, { status: 400 })
  }
  if (order.endTime <= BigInt(Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ ok: false, error: 'order already expired' }, { status: 400 })
  }

  let accepted
  try {
    accepted = await assertAcceptedStudioOrder(order)
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message || 'order rejected' }, { status: 400 })
  }
  const { nft, tokenId, priceAtomic, kind: acceptedKind } = accepted
  if (acceptedKind !== kind) {
    return NextResponse.json({ ok: false, error: 'order kind mismatch' }, { status: 400 })
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

  if (kind === 'listing') {
    const owner = (await c.readContract({
      address: nft,
      abi: [
        { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
      ] as const,
      functionName: 'ownerOf',
      args: [offer.identifierOrCriteria],
    }).catch(() => null)) as Address | null
    if (!owner || owner.toLowerCase() !== order.offerer.toLowerCase()) {
      return NextResponse.json({ ok: false, error: 'offerer does not own this token' }, { status: 400 })
    }
  }

  const row: StoredOrder = {
    orderHash,
    order: body.order,
    signature: body.signature,
    collection: nft,
    tokenId,
    priceAtomic: priceAtomic.toString(),
    offerer: order.offerer,
    endTime: order.endTime.toString(),
    createdAt: Date.now(),
    kind,
  }
  await kv.set(ORDER_KEY(orderHash), row, { ex: MAX_TTL_SEC })
  await kv.sadd(COLLECTION_SET(nft), orderHash)

  if (kind === 'listing') {
    try {
      const hashes = ((await kv.smembers(COLLECTION_SET(nft))) as string[]) || []
      const others = (
        await Promise.all(hashes.filter((h) => h.toLowerCase() !== orderHash.toLowerCase()).map((h) => kv.get<StoredOrder>(ORDER_KEY(h))))
      ).filter((r): r is StoredOrder => !!r && r.tokenId === row.tokenId && (r.kind || 'listing') === 'listing')
      await Promise.all(others.map((r) => kv.srem(COLLECTION_SET(nft), r.orderHash)))
    } catch {
      /* kv optional */
    }
  }

  await recordActivity({
    type: kind === 'listing' ? 'list' : 'offer',
    collection: row.collection,
    tokenId: row.tokenId,
    priceAtomic: row.priceAtomic,
    from: row.offerer,
    orderHash,
    at: Date.now(),
  })
  const { snapshot } = await syncCollection(nft)

  return NextResponse.json({ ok: true, orderHash, priceAtomic: row.priceAtomic, kind, ...snapshot })
}

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'studio-orders-get', 40)
  if (limited) return limited
  const collection = req.nextUrl.searchParams.get('collection') || ''
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }

  try {
    const { listings, snapshot } = await syncCollection(collection)
    const kind = req.nextUrl.searchParams.get('kind') as Listing['kind'] | null
    let rows = listings
    if (kind === 'listing') rows = rows.filter((l) => (l.kind || 'listing') === 'listing')
    if (kind === 'offer') {
      rows = rows.filter((l) => l.kind === 'offer' || l.kind === 'collection-offer')
    }
    if (kind === 'collection-offer') rows = rows.filter((l) => l.kind === 'collection-offer')
    if (tokenId) {
      rows = rows.filter((l) => l.tokenId === tokenId || l.kind === 'collection-offer')
    }
    return NextResponse.json({ ok: true, listings: rows, ...snapshot })
  } catch {
    return NextResponse.json({ ok: false, error: 'order store unavailable', listings: [] }, { status: 503 })
  }
}

export async function PATCH(req: NextRequest) {
  const limited = await limitOr429(req, 'studio-orders-patch', 40)
  if (limited) return limited
  const body = (await req.json().catch(() => null)) as {
    orderHash?: string
    action?: 'filled' | 'cancel'
    txHash?: string
    buyer?: string
    tokenId?: string
  } | null
  const orderHash = (body?.orderHash || '').trim()
  const action = body?.action
  if (!orderHash || (action !== 'filled' && action !== 'cancel')) {
    return NextResponse.json({ ok: false, error: 'orderHash and action required' }, { status: 400 })
  }
  if (!isTxHash(body?.txHash)) {
    return NextResponse.json({ ok: false, error: 'txHash required' }, { status: 400 })
  }
  const row = await getStoredOrder(orderHash)
  if (!row) return NextResponse.json({ ok: false, error: 'unknown order' }, { status: 404 })

  let receipt
  try {
    receipt = await client().getTransactionReceipt({ hash: body.txHash })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not read tx: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }

  if (action === 'filled') {
    const fill = readFillFromReceipt(receipt, row.orderHash, row.kind)
    if (!fill) {
      return NextResponse.json({ ok: false, error: 'tx did not fill this order on Seaport' }, { status: 400 })
    }
    await recordActivity({
      type: fillActivityType(row.kind),
      collection: row.collection,
      tokenId: fill.tokenId || row.tokenId,
      priceAtomic: row.priceAtomic,
      from: fill.from,
      to: fill.to,
      orderHash: row.orderHash,
      txHash: body.txHash,
      at: Date.now(),
    })
  } else {
    if (!readCancelFromReceipt(receipt, row.orderHash, row.offerer)) {
      return NextResponse.json({ ok: false, error: 'tx did not cancel this order on Seaport' }, { status: 400 })
    }
    await recordActivity({
      type: 'cancel',
      collection: row.collection,
      tokenId: row.tokenId,
      priceAtomic: row.priceAtomic,
      from: row.offerer,
      orderHash: row.orderHash,
      txHash: body.txHash,
      at: Date.now(),
    })
  }
  await dropOrder(row.collection, row.orderHash)
  const { snapshot } = await syncCollection(row.collection)
  return NextResponse.json({ ok: true, ...snapshot })
}
