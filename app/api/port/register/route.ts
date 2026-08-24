import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress, type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { parseAuthFields } from '@/lib/arc-auth'
import { verifyCollectionAuth } from '@/lib/arc-auth-server'
import { setPortCollectionMeta } from '@/lib/port/meta'
import { readCollectionAuthContext } from '@/lib/port/owner'
import { sanitizeHttpsUrl, sanitizeTelegram, sanitizeTwitter, sanitizeWebsite } from '@/lib/social-href'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { arcPublicClient } from '@/lib/contracts-arc'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'port-register', 10, 60, true)
  if (limited) return limited
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
    signature?: string
    timestamp?: number
    nonce?: string
  }

  const address = body.address
  if (!address || !isPlausibleEvmAddress(address) || !isAddress(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  const ctx = await readCollectionAuthContext(address)
  if (!ctx) return NextResponse.json({ error: 'not an ArcStudio collection' }, { status: 404 })

  const parsed = parseAuthFields(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const collection = getAddress(address)
  const payload = {
    collection,
    name: typeof body.name === 'string' ? body.name : '',
    symbol: typeof body.symbol === 'string' ? body.symbol : '',
    description: typeof body.description === 'string' ? body.description : '',
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : '',
    bannerUrl: typeof body.bannerUrl === 'string' ? body.bannerUrl : '',
    twitter: typeof body.twitter === 'string' ? body.twitter : '',
    telegram: typeof body.telegram === 'string' ? body.telegram : '',
    website: typeof body.website === 'string' ? body.website : '',
  }
  const auth = await verifyCollectionAuth({
    owner: ctx.owner,
    collection,
    action: 'register-collection',
    payload,
    signature: parsed.signature,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 })

  const imageUrl = payload.imageUrl ? sanitizeHttpsUrl(payload.imageUrl) : ''
  if (payload.imageUrl && !imageUrl) {
    return NextResponse.json({ error: 'image must be an https URL' }, { status: 400 })
  }
  const bannerUrl = payload.bannerUrl ? sanitizeHttpsUrl(payload.bannerUrl) : ''
  if (payload.bannerUrl && !bannerUrl) {
    return NextResponse.json({ error: 'banner must be an https URL' }, { status: 400 })
  }
  const website = payload.website ? sanitizeWebsite(payload.website) : ''
  if (payload.website && !website) {
    return NextResponse.json({ error: 'website must be https' }, { status: 400 })
  }

  let originToken: string | undefined
  try {
    const origin = (await arcPublicClient().readContract({
      address: collection as Address,
      abi: PORT_NFT_ABI,
      functionName: 'originToken',
    })) as Address
    if (origin && origin !== '0x0000000000000000000000000000000000000000') originToken = origin
  } catch {
    originToken = undefined
  }

  try {
    await setPortCollectionMeta(address, {
      name: payload.name.trim().slice(0, 64) || undefined,
      symbol: payload.symbol.trim().slice(0, 16) || undefined,
      description: payload.description.trim().slice(0, 280),
      imageUrl: imageUrl || undefined,
      bannerUrl: bannerUrl || undefined,
      twitter: payload.twitter ? sanitizeTwitter(payload.twitter) : '',
      telegram: payload.telegram ? sanitizeTelegram(payload.telegram) : '',
      website,
      creator: ctx.owner,
      originToken,
    })
  } catch {
    return NextResponse.json({ error: 'could not save collection' }, { status: 503 })
  }

  return NextResponse.json({ ok: true, address: collection })
}
