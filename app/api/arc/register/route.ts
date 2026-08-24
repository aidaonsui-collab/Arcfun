/**
 * POST /api/arc/register — display metadata for Arc Instant launches.
 * Requires a signature from the on-chain Instant/Reflection creator.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress, type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { parseAuthFields } from '@/lib/arc-auth'
import { verifyTokenRegisterAuth } from '@/lib/arc-auth-server'
import { setArcTokenMeta } from '@/lib/arc-token-meta'
import { invalidateArcHomeCatalog } from '@/lib/arc-catalog-cache'
import { readPadCreator } from '@/lib/port/origin-token'
import { sanitizeHttpsUrl, sanitizeTelegram, sanitizeTwitter, sanitizeWebsite } from '@/lib/social-href'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'arc-register', 10)
  if (limited) return limited
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
    pool?: string
    signature?: string
    timestamp?: number
    nonce?: string
  }

  const token = body.token
  if (!token || !isPlausibleEvmAddress(token) || !isAddress(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 })
  }

  const creator = await readPadCreator(token as Address)
  if (!creator) {
    return NextResponse.json({ error: 'not an ArcFun launch' }, { status: 404 })
  }

  const parsed = parseAuthFields(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const checksum = getAddress(token)
  const payload = {
    token: checksum,
    name: typeof body.name === 'string' ? body.name : '',
    symbol: typeof body.symbol === 'string' ? body.symbol : '',
    description: typeof body.description === 'string' ? body.description : '',
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : '',
    twitter: typeof body.twitter === 'string' ? body.twitter : '',
    telegram: typeof body.telegram === 'string' ? body.telegram : '',
    website: typeof body.website === 'string' ? body.website : '',
    streamUrl: typeof body.streamUrl === 'string' ? body.streamUrl : '',
    pool: typeof body.pool === 'string' ? body.pool : '',
  }
  const auth = await verifyTokenRegisterAuth({
    creator,
    token: checksum,
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
  const website = payload.website ? sanitizeWebsite(payload.website) : ''
  if (payload.website && !website) {
    return NextResponse.json({ error: 'website must be https' }, { status: 400 })
  }
  const streamUrl = payload.streamUrl ? sanitizeHttpsUrl(payload.streamUrl) : ''
  if (payload.streamUrl && !streamUrl) {
    return NextResponse.json({ error: 'stream URL must be https' }, { status: 400 })
  }
  const pool = payload.pool && isPlausibleEvmAddress(payload.pool) ? getAddress(payload.pool) : undefined

  try {
    await setArcTokenMeta(token, {
      name: payload.name.trim().slice(0, 64) || undefined,
      symbol: payload.symbol.trim().slice(0, 16) || undefined,
      imageUrl: imageUrl || undefined,
      description: payload.description.trim().slice(0, 280) || undefined,
      twitter: payload.twitter ? sanitizeTwitter(payload.twitter) : '',
      telegram: payload.telegram ? sanitizeTelegram(payload.telegram) : '',
      website,
      streamUrl: streamUrl || undefined,
      creator,
      pool,
      instantLaunch: true,
    })
  } catch {
    return NextResponse.json({ error: 'could not save token' }, { status: 503 })
  }

  try {
    await invalidateArcHomeCatalog()
  } catch {
    /* catalog will refresh on TTL */
  }

  return NextResponse.json({ ok: true, chain: 'arc', token: checksum })
}
