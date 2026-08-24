import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { listTokenHolders } from '@/lib/port/holders'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const collection = (req.nextUrl.searchParams.get('collection') || '').trim()
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  try {
    const { minted, holders } = await listTokenHolders(collection)
    return NextResponse.json({ ok: true, minted, holders })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message?.slice(0, 160) || 'could not read holders' },
      { status: 502 },
    )
  }
}
