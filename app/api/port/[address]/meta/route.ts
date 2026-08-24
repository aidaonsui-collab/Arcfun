/**
 * PUT /api/port/[address]/meta — collection owner updates off-chain banner (and optional image).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { parseAuthFields } from '@/lib/arc-auth'
import { verifyCollectionAuth } from '@/lib/arc-auth-server'
import { setPortCollectionMeta } from '@/lib/port/meta'
import { readCollectionOwner } from '@/lib/port/owner'
import { sanitizeHttpsUrl, sanitizeTelegram, sanitizeTwitter, sanitizeWebsite } from '@/lib/social-href'

export const dynamic = 'force-dynamic'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: pathAddr } = await params
  if (!isPlausibleEvmAddress(pathAddr)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    address?: string
    signature?: string
    timestamp?: number
    nonce?: string
    bannerUrl?: string
    description?: string
    twitter?: string
    telegram?: string
    website?: string
  }

  const collection = (body.address || pathAddr).trim()
  if (!isAddress(collection) || collection.toLowerCase() !== pathAddr.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'address mismatch' }, { status: 400 })
  }

  const owner = await readCollectionOwner(collection)
  if (!owner) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })

  const parsed = parseAuthFields(body)
  if ('error' in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })

  const payload = {
    collection: getAddress(collection),
    bannerUrl: typeof body.bannerUrl === 'string' ? body.bannerUrl : '',
    description: typeof body.description === 'string' ? body.description : '',
    twitter: typeof body.twitter === 'string' ? body.twitter : '',
    telegram: typeof body.telegram === 'string' ? body.telegram : '',
    website: typeof body.website === 'string' ? body.website : '',
  }
  const auth = await verifyCollectionAuth({
    owner,
    collection,
    action: 'update-collection',
    payload,
    signature: parsed.signature,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  })
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })

  const bannerUrl = payload.bannerUrl ? sanitizeHttpsUrl(payload.bannerUrl) : ''
  if (payload.bannerUrl && !bannerUrl) {
    return NextResponse.json({ ok: false, error: 'banner must be an https URL' }, { status: 400 })
  }
  const website = payload.website ? sanitizeWebsite(payload.website) : ''
  if (payload.website && !website) {
    return NextResponse.json({ ok: false, error: 'website must be https' }, { status: 400 })
  }

  try {
    await setPortCollectionMeta(collection, {
      bannerUrl,
      description: payload.description.trim().slice(0, 280),
      twitter: payload.twitter ? sanitizeTwitter(payload.twitter) : '',
      telegram: payload.telegram ? sanitizeTelegram(payload.telegram) : '',
      website,
    })
    return NextResponse.json({
      ok: true,
      bannerUrl,
      description: payload.description.trim().slice(0, 280),
      twitter: payload.twitter ? sanitizeTwitter(payload.twitter) : '',
      telegram: payload.telegram ? sanitizeTelegram(payload.telegram) : '',
      website,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || 'kv write failed' },
      { status: 500 },
    )
  }
}
