/**
 * GET  /api/arc/blitz/launch?tweet=ID — invoice + x402 requirements for the pay page.
 * POST /api/arc/blitz/launch?tweet=ID — settle X-PAYMENT (nanogas USDC) then Instant-create.
 */
import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { blitzLaunchEnabled } from '@/lib/arc-blitz'
import {
  BLITZ_AUTHOR_TTL_SEC,
  blitzAuthorKey,
  blitzDailyCap,
  dailyMintsUsed,
  takeDailyMintSlot,
} from '@/lib/arc-blitz-guards'
import { loadBlitzInvoice } from '@/lib/arc-blitz-invoice'
import { blitzBotPrivateKey, mintOnArc } from '@/lib/arc-blitz-mint'
import { blitzLaunchRequirements, blitzLaunchUsdLabel, blitzPayEnabled } from '@/lib/arc-blitz-pay'
import {
  X402_VERSION,
  decodePaymentHeader,
  encodePaymentResponse,
  settlePayment,
  verifyPayment,
} from '@/lib/x402'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function tweetIdOf(req: NextRequest): string {
  return (req.nextUrl.searchParams.get('tweet') || '').trim()
}

async function authorSeen(id: string): Promise<boolean> {
  try {
    return Boolean(await kv.get(blitzAuthorKey(id)))
  } catch {
    return true
  }
}

export async function GET(req: NextRequest) {
  if (!blitzLaunchEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!blitzPayEnabled()) {
    return NextResponse.json({ error: 'blitz nanogas pay is not configured' }, { status: 503 })
  }
  const tweetId = tweetIdOf(req)
  if (!tweetId) return NextResponse.json({ error: 'tweet required' }, { status: 400 })
  const invoice = await loadBlitzInvoice(tweetId).catch(() => null)
  if (!invoice) return NextResponse.json({ error: 'invoice expired or not found' }, { status: 404 })

  const resource = new URL(req.url).toString()
  const requirements = blitzLaunchRequirements(resource)
  return NextResponse.json({
    x402Version: X402_VERSION,
    priceLabel: blitzLaunchUsdLabel(),
    invoice: {
      tweetId: invoice.tweetId,
      handle: invoice.handle,
      name: invoice.name,
      symbol: invoice.symbol,
    },
    accepts: [requirements],
  })
}

export async function POST(req: NextRequest) {
  if (!blitzLaunchEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!blitzPayEnabled()) {
    return NextResponse.json({ error: 'blitz nanogas pay is not configured' }, { status: 503 })
  }
  const tweetId = tweetIdOf(req)
  if (!tweetId) return NextResponse.json({ error: 'tweet required' }, { status: 400 })
  const invoice = await loadBlitzInvoice(tweetId).catch(() => null)
  if (!invoice) return NextResponse.json({ error: 'invoice expired or not found' }, { status: 404 })

  const pk = blitzBotPrivateKey()
  if (!pk) return NextResponse.json({ error: 'mint wallet not configured' }, { status: 503 })

  if (await authorSeen(invoice.authorId)) {
    return NextResponse.json({ error: 'this X account already launched in the last 24h' }, { status: 429 })
  }
  const cap = blitzDailyCap()
  if (cap > 0 && (await dailyMintsUsed()) >= cap) {
    return NextResponse.json({ error: `daily launch cap (${cap}) reached` }, { status: 429 })
  }

  const resource = new URL(req.url).toString()
  const requirements = blitzLaunchRequirements(resource)
  const decoded = decodePaymentHeader(req.headers.get('x-payment') || req.headers.get('X-PAYMENT'))
  if (!decoded.ok) {
    return NextResponse.json(
      { x402Version: X402_VERSION, error: decoded.error, accepts: [requirements] },
      { status: 402 },
    )
  }
  const verified = await verifyPayment(decoded.payload, requirements)
  if (!verified.ok) {
    return NextResponse.json(
      { x402Version: X402_VERSION, error: verified.error, accepts: [requirements] },
      { status: 402 },
    )
  }

  const settled = await settlePayment(decoded.payload)
  if (!settled.ok) {
    return NextResponse.json(
      { x402Version: X402_VERSION, error: `settlement failed: ${settled.error}`, accepts: [requirements] },
      { status: 402, headers: { 'X-PAYMENT-RESPONSE': encodePaymentResponse(settled) } },
    )
  }

  try {
    const minted = await mintOnArc({
      name: invoice.name,
      symbol: invoice.symbol,
      tweet: invoice.tweet,
      pk,
    })
    await takeDailyMintSlot()
    await kv.set(blitzAuthorKey(invoice.authorId), minted.token, { ex: BLITZ_AUTHOR_TTL_SEC })
    return NextResponse.json(
      { ok: true, token: minted.token, tx: minted.tx, pool: minted.pool },
      { headers: { 'X-PAYMENT-RESPONSE': encodePaymentResponse(settled) } },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : 'mint failed' },
      { status: 500, headers: { 'X-PAYMENT-RESPONSE': encodePaymentResponse(settled) } },
    )
  }
}
