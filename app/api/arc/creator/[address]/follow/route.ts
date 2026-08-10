/**
 * POST /api/arc/creator/[address]/follow — follow / unfollow (signed).
 * GET  — counts + whether viewer follows (optional ?viewer=)
 */
import { NextRequest, NextResponse } from 'next/server'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { followMessage, verifyWalletAuth } from '@/lib/arc-auth'
import { follow, getFollowCounts, isFollowing, unfollow } from '@/lib/arc-followers'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isPlausibleEvmAddress(address)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }
  const viewer = req.nextUrl.searchParams.get('viewer') || ''
  const counts = await getFollowCounts(address)
  let following = false
  if (viewer && isPlausibleEvmAddress(viewer)) {
    following = await isFollowing(viewer, address)
  }
  return NextResponse.json({ ok: true, ...counts, viewerFollowing: following })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: target } = await params
  if (!isPlausibleEvmAddress(target)) {
    return NextResponse.json({ ok: false, error: 'invalid target' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    follower?: string
    action?: 'follow' | 'unfollow'
    signature?: string
    timestamp?: number
  }

  const follower = (body.follower || '').trim()
  const action = body.action === 'unfollow' ? 'unfollow' : 'follow'
  if (!isPlausibleEvmAddress(follower)) {
    return NextResponse.json({ ok: false, error: 'invalid follower' }, { status: 400 })
  }
  if (follower.toLowerCase() === target.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'cannot follow yourself' }, { status: 400 })
  }

  const timestamp = Number(body.timestamp)
  const message = followMessage(follower, target, action, timestamp)
  const auth = await verifyWalletAuth({
    address: follower,
    message,
    signature: body.signature || '',
    timestamp,
  })
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 })
  }

  try {
    if (action === 'follow') await follow(auth.address, target)
    else await unfollow(auth.address, target)
    const counts = await getFollowCounts(target)
    return NextResponse.json({
      ok: true,
      action,
      ...counts,
      viewerFollowing: action === 'follow',
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || 'follow failed' },
      { status: 500 },
    )
  }
}
