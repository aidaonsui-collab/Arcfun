/**
 * POST /api/handle-pay/auth/verify
 * Exchange the X OAuth code, confirm the username matches the handle, issue a verifyToken.
 */
import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import crypto from 'crypto'
import {
  handlePayOAuthClientId,
  handlePayOAuthClientSecret,
  handlePayOAuthConfigured,
  handlePayRedirectUri,
} from '@/lib/handle-pay-oauth'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const VERIFY_TTL_SECONDS = 15 * 60

interface PendingState {
  codeVerifier: string
  giftId: string
  walletAddress: string
  recipientHandle: string
}

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'handle-pay-auth-verify', 8, 60, true)
  if (limited) return limited

  try {
    if (!handlePayOAuthConfigured()) {
      return NextResponse.json({ error: 'X verification is not live yet' }, { status: 503 })
    }

    const { code, state } = await req.json()
    if (!code || !state) {
      return NextResponse.json({ error: 'code and state are required' }, { status: 400 })
    }

    const key = `handlepay:oauth-state:${state}`
    const pending = await kv.get<PendingState>(key)
    if (!pending) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 })
    }
    await kv.del(key)

    const clientId = handlePayOAuthClientId()
    const clientSecret = handlePayOAuthClientSecret()
    const redirectUri = handlePayRedirectUri()
    const isConfidential = clientSecret.length > 0
    const tokenHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (isConfidential) {
      tokenHeaders.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    }

    const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: tokenHeaders,
      body: new URLSearchParams({
        code: String(code),
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
      }),
    })
    const tokenData = (await tokenResp.json().catch(() => ({}))) as {
      access_token?: string
      error?: string
      error_description?: string
    }
    if (!tokenData.access_token) {
      console.error('[handle-pay/auth/verify] token exchange failed', tokenData)
      return NextResponse.json(
        {
          error:
            'Failed to get access token: ' + (tokenData.error_description || tokenData.error || 'unknown'),
        },
        { status: 400 },
      )
    }

    const userResp = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const userData = (await userResp.json().catch(() => ({}))) as { data?: { username?: string } }
    const username = userData?.data?.username?.toLowerCase()
    if (!username) {
      return NextResponse.json({ error: 'Could not retrieve X username' }, { status: 400 })
    }
    if (username !== pending.recipientHandle) {
      return NextResponse.json(
        {
          error: `Logged in as @${username} but this vault is for @${pending.recipientHandle}. Use the matching X account.`,
        },
        { status: 403 },
      )
    }

    const verifyToken = crypto.randomBytes(32).toString('hex')
    await kv.set(
      `handlepay:verify:${verifyToken}`,
      {
        username,
        giftId: pending.giftId,
        walletAddress: pending.walletAddress,
      },
      { ex: VERIFY_TTL_SECONDS },
    )

    return NextResponse.json({
      verified: true,
      username,
      verifyToken,
      giftId: pending.giftId,
      walletAddress: pending.walletAddress,
      expiresIn: VERIFY_TTL_SECONDS,
    })
  } catch (e) {
    console.error('[handle-pay/auth/verify]', e)
    return NextResponse.json({ error: (e as Error).message || 'Unknown error' }, { status: 500 })
  }
}
