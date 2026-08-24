import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { collectionItemsEditMessage, verifyWalletAuth } from '@/lib/arc-auth'
import { cleanTraits, getPortItems, mergePortItems, type PortItemMeta } from '@/lib/port/item-meta'
import { readCollectionOwner } from '@/lib/port/owner'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }
  const store = await getPortItems(address)
  return NextResponse.json({ ok: true, ...store })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: pathAddr } = await params
  const body = (await req.json().catch(() => ({}))) as {
    address?: string
    signature?: string
    timestamp?: number
    items?: Record<string, PortItemMeta | null>
  }
  const collection = (body.address || pathAddr).trim()
  if (!isAddress(collection) || collection.toLowerCase() !== pathAddr.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'address mismatch' }, { status: 400 })
  }
  const owner = await readCollectionOwner(collection)
  if (!owner) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

  const timestamp = Number(body.timestamp)
  const auth = await verifyWalletAuth({
    address: owner,
    message: collectionItemsEditMessage(collection, timestamp),
    signature: body.signature || '',
    timestamp,
  })
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })

  const patch = body.items || {}
  const cleaned: Record<string, PortItemMeta | null> = {}
  for (const [id, meta] of Object.entries(patch)) {
    const n = Number(id)
    if (!Number.isInteger(n) || n < 1) continue
    if (!meta) {
      cleaned[String(n)] = null
      continue
    }
    if (!meta.imageUrl || !/^https?:\/\//i.test(meta.imageUrl)) continue
    const traits = Array.isArray(meta.traits) ? cleanTraits(meta.traits) || [] : undefined
    cleaned[String(n)] = {
      imageUrl: meta.imageUrl.trim().slice(0, 512),
      name: meta.name?.trim().slice(0, 64),
      description: meta.description?.trim().slice(0, 280),
      ...(traits ? { traits } : {}),
    }
  }
  const store = await mergePortItems(collection, cleaned)
  return NextResponse.json({ ok: true, ...store })
}
