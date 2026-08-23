import { NextRequest, NextResponse } from 'next/server'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { setPortCollectionMeta } from '@/lib/port/meta'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    address?: string
    name?: string
    symbol?: string
    description?: string
    imageUrl?: string
    bannerUrl?: string
    twitter?: string
    telegram?: string
    website?: string
    creator?: string
    originToken?: string
  }

  const address = body.address
  if (!address || !isPlausibleEvmAddress(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  try {
    await setPortCollectionMeta(address, {
      name: body.name,
      symbol: body.symbol,
      description: body.description,
      imageUrl: body.imageUrl,
      bannerUrl: body.bannerUrl || body.imageUrl,
      twitter: body.twitter?.trim() || undefined,
      telegram: body.telegram?.trim() || undefined,
      website: body.website?.trim() || undefined,
      creator: body.creator,
      originToken: body.originToken,
    })
  } catch {
    /* kv best-effort */
  }

  return NextResponse.json({ ok: true, address })
}
