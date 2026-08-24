import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { verifyOwnerRead } from '@/lib/arc-auth-server'
import { listTokenHolders } from '@/lib/port/holders'
import { readCollectionAuthContext } from '@/lib/port/owner'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'studio-holders', 10, 60, true)
  if (limited) return limited
  const collection = (req.nextUrl.searchParams.get('collection') || '').trim()
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  try {
    const ctx = await readCollectionAuthContext(collection)
    if (!ctx) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

    const { minted, holders } = await listTokenHolders(collection)
    const ownerRead =
      !ctx.revealed &&
      (await verifyOwnerRead({
        owner: ctx.owner,
        collection,
        action: 'read-holders',
        searchParams: req.nextUrl.searchParams,
      }))

    if (!ctx.revealed && !ownerRead) {
      return NextResponse.json({
        ok: true,
        minted,
        holders: holders.map((h) => ({
          tokenId: h.tokenId,
          owner: h.owner,
          name: `${h.tokenId}`,
          rarity: '',
          traits: [],
        })),
      })
    }

    return NextResponse.json({ ok: true, minted, holders })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message?.slice(0, 160) || 'could not read holders' },
      { status: 502 },
    )
  }
}
