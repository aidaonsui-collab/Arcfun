import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { parseAuthFields } from '@/lib/arc-auth'
import { verifyCollectionAuth, verifyOwnerRead } from '@/lib/arc-auth-server'
import { cleanTraits, getPortItems, mergePortItems, type PortItemMeta } from '@/lib/port/item-meta'
import { readCollectionAuthContext } from '@/lib/port/owner'
import { sanitizeHttpsUrl } from '@/lib/social-href'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const limited = await limitOr429(req, 'port-items-get', 40)
  if (limited) return limited
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }
  const ctx = await readCollectionAuthContext(address)
  if (!ctx) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

  if (!ctx.revealed) {
    const ok = await verifyOwnerRead({
      owner: ctx.owner,
      collection: address,
      action: 'read-items',
      searchParams: req.nextUrl.searchParams,
    })
    if (!ok) {
      return NextResponse.json({ ok: true, items: {}, updatedAt: 0 })
    }
  }

  const store = await getPortItems(address)
  return NextResponse.json({ ok: true, ...store })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const limited = await limitOr429(req, 'port-items-put', 30)
  if (limited) return limited
  const { address: pathAddr } = await params
  const body = (await req.json().catch(() => ({}))) as {
    address?: string
    signature?: string
    timestamp?: number
    nonce?: string
    items?: Record<string, PortItemMeta | null>
  }
  const collection = (body.address || pathAddr).trim()
  if (!isAddress(collection) || collection.toLowerCase() !== pathAddr.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'address mismatch' }, { status: 400 })
  }
  const ctx = await readCollectionAuthContext(collection)
  if (!ctx) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

  const parsed = parseAuthFields(body)
  if ('error' in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })

  const items = body.items || {}
  const auth = await verifyCollectionAuth({
    owner: ctx.owner,
    collection,
    action: 'update-items',
    payload: { collection: getAddress(collection), items },
    signature: parsed.signature,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  })
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })

  const cleaned: Record<string, PortItemMeta | null> = {}
  for (const [id, meta] of Object.entries(items)) {
    const n = Number(id)
    if (!Number.isInteger(n) || n < 1) continue
    if (!meta) {
      cleaned[String(n)] = null
      continue
    }
    const imageUrl = meta.imageUrl ? sanitizeHttpsUrl(meta.imageUrl) : ''
    if (!imageUrl) continue
    const traits = Array.isArray(meta.traits) ? cleanTraits(meta.traits) || [] : undefined
    cleaned[String(n)] = {
      imageUrl,
      name: meta.name?.trim().slice(0, 64),
      description: meta.description?.trim().slice(0, 280),
      ...(traits ? { traits } : {}),
    }
  }
  const store = await mergePortItems(collection, cleaned)
  return NextResponse.json({ ok: true, ...store })
}
