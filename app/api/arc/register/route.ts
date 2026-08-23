/**
 * POST /api/arc/register — display metadata for Arc Instant launches.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { setArcTokenMeta } from '@/lib/arc-token-meta'
import { invalidateArcHomeCatalog } from '@/lib/arc-catalog-cache'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    token?: string
    name?: string
    symbol?: string
    description?: string
    imageUrl?: string
    twitter?: string
    telegram?: string
    website?: string
    streamUrl?: string
    creator?: string
    pool?: string
  }

  const token = body.token
  if (!token || !isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }

  if (body.name) {
    try {
      await setArcTokenMeta(token, {
        name: body.name,
        symbol: body.symbol,
        imageUrl: body.imageUrl,
        description: body.description,
        twitter: body.twitter?.trim() || undefined,
        telegram: body.telegram?.trim() || undefined,
        website: body.website?.trim() || undefined,
        streamUrl: body.streamUrl?.trim() || undefined,
        creator: body.creator,
        pool:
          body.pool && isPlausibleEvmAddress(body.pool) ? body.pool : undefined,
        instantLaunch: true,
      })
    } catch {
      /* meta best-effort */
    }
  }

  try {
    await invalidateArcHomeCatalog()
  } catch {
    /* catalog will refresh on TTL */
  }

  return NextResponse.json({ ok: true, chain: 'arc', token })
}
