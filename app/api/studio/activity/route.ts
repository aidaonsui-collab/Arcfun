import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getActivity } from '@/lib/port/market'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get('collection') || ''
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  const activity = await getActivity(collection, tokenId || undefined)
  return NextResponse.json({ ok: true, activity })
}
