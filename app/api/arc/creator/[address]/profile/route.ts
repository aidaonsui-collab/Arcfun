/**
 * PUT /api/arc/creator/[address]/profile — signed update of display name / bio / avatar / X.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { profileEditMessage, verifyWalletAuth } from '@/lib/arc-auth'
import { sanitizeCreatorMeta, setCreatorMeta } from '@/lib/arc-creator-meta'

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
    displayName?: string
    bio?: string
    avatarUrl?: string
    twitter?: string
  }

  const address = (body.address || pathAddr).trim()
  if (address.toLowerCase() !== pathAddr.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'address mismatch' }, { status: 400 })
  }

  const timestamp = Number(body.timestamp)
  const message = profileEditMessage(address, timestamp)
  const auth = await verifyWalletAuth({
    address,
    message,
    signature: body.signature || '',
    timestamp,
  })
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })
  }

  const patch = sanitizeCreatorMeta({
    displayName: body.displayName,
    bio: body.bio,
    avatarUrl: body.avatarUrl,
    twitter: body.twitter,
  })

  try {
    const meta = await setCreatorMeta(auth.address, patch)
    return NextResponse.json({ ok: true, meta })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || 'kv write failed' },
      { status: 500 },
    )
  }
}
