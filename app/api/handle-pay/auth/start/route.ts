/**
 * POST /api/handle-pay/auth/start
 * First leg of the X OAuth2 PKCE flow for HandlePay claims.
 */
import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import crypto from 'crypto'
import { isAddress } from 'viem'
import { normaliseXHandle, handlePayGiftId, handlePayEnabled } from '@/lib/handle-pay'
import {
  handlePayOAuthClientId,
  handlePayOAuthConfigured,
  handlePayRedirectUri,
} from '@/lib/handle-pay-oauth'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const STATE_TTL_SECONDS = 10 * 60

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'handle-pay-auth-start', 8, 60, true)
  if (limited) return limited

  try {
    if (!handlePayEnabled()) {
      return NextResponse.json({ error: 'HandlePay is not configured' }, { status: 503 })
    }
    if (!handlePayOAuthConfigured()) {
      return NextResponse.json(
        { error: 'X verification is not live yet. Fees still accrue in the handle vault.' },
        { status: 503 },
      )
    }

    const body = await req.json()
    const handle = normaliseXHandle(String(body.handle || body.recipientHandle || ''))
    const walletAddress = String(body.walletAddress || '')
    if (!handle || !walletAddress) {
      return NextResponse.json({ error: 'handle and walletAddress are required' }, { status: 400 })
    }
    if (!isAddress(walletAddress)) {
      return NextResponse.json({ error: 'walletAddress must be a valid 0x address' }, { status: 400 })
    }

    const clientId = handlePayOAuthClientId()
    const redirectUri = handlePayRedirectUri()
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString('hex')

    await kv.set(
      `handlepay:oauth-state:${state}`,
      {
        codeVerifier,
        giftId: handlePayGiftId(handle),
        walletAddress,
        recipientHandle: handle,
      },
      { ex: STATE_TTL_SECONDS },
    )

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'tweet.read users.read',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    return NextResponse.json({
      authUrl: `https://twitter.com/i/oauth2/authorize?${params.toString()}`,
      state,
      redirectUri,
    })
  } catch (e) {
    console.error('[handle-pay/auth/start]', e)
    return NextResponse.json({ error: (e as Error).message || 'Unknown error' }, { status: 500 })
  }
}
