import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { kv } from '@vercel/kv'
import { parseAuthFields } from '@/lib/arc-auth'
import { verifyCollectionAuth, verifyOwnerRead } from '@/lib/arc-auth-server'
import { allowlistProof, buildAllowlist, parseWallets } from '@/lib/port/merkle'
import { readCollectionOwner } from '@/lib/port/owner'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const KEY = (c: string) => `arcfun:studio:allowlist:${c.toLowerCase()}`

type Store = { wallets: Address[]; root: Hex; updatedAt: number }

async function load(collection: string): Promise<Store> {
  try {
    const row = await kv.get<Store>(KEY(collection))
    if (row?.wallets) return row
  } catch {
    /* kv optional */
  }
  return { wallets: [], root: '0x0000000000000000000000000000000000000000000000000000000000000000', updatedAt: 0 }
}

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'studio-allowlist-get', 60)
  if (limited) return limited
  const collection = (req.nextUrl.searchParams.get('collection') || '').trim()
  const wallet = (req.nextUrl.searchParams.get('wallet') || '').trim()
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  const store = await load(collection)
  if (wallet && isAddress(wallet)) {
    const onList = store.wallets.some((w) => w.toLowerCase() === wallet.toLowerCase())
    return NextResponse.json({
      ok: true,
      onList,
      proof: onList ? allowlistProof(store.wallets, wallet) : [],
      root: store.root,
      count: store.wallets.length,
    })
  }

  const owner = await readCollectionOwner(collection)
  const canReadList =
    !!owner &&
    (await verifyOwnerRead({
      owner,
      collection,
      action: 'read-allowlist',
      searchParams: req.nextUrl.searchParams,
    }))

  if (canReadList) {
    return NextResponse.json({
      ok: true,
      wallets: store.wallets,
      root: store.root,
      count: store.wallets.length,
      updatedAt: store.updatedAt,
    })
  }

  return NextResponse.json({
    ok: true,
    root: store.root,
    count: store.wallets.length,
    updatedAt: store.updatedAt,
  })
}

export async function PUT(req: NextRequest) {
  const limited = await limitOr429(req, 'studio-allowlist-put', 20)
  if (limited) return limited
  const body = (await req.json().catch(() => ({}))) as {
    collection?: string
    wallets?: string
    signature?: string
    timestamp?: number
    nonce?: string
  }
  const collection = (body.collection || '').trim()
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  const owner = await readCollectionOwner(collection)
  if (!owner) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

  const parsed = parseAuthFields(body)
  if ('error' in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })

  const walletsText = String(body.wallets || '')
  const auth = await verifyCollectionAuth({
    owner,
    collection,
    action: 'update-allowlist',
    payload: { collection: getAddress(collection), wallets: walletsText },
    signature: parsed.signature,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  })
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })

  const wallets = parseWallets(walletsText)
  const { root, sorted } = buildAllowlist(wallets)
  const store: Store = { wallets: sorted, root, updatedAt: Date.now() }
  try {
    await kv.set(KEY(collection), store)
  } catch {
    return NextResponse.json({ ok: false, error: 'could not save allowlist' }, { status: 503 })
  }
  return NextResponse.json({ ok: true, root, count: sorted.length, wallets: sorted })
}
