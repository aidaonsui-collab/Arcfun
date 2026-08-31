/**
 * GET /api/arc/quote?token=0x&side=buy|sell&amount=123
 * Server-side Uni V3 quote. The trade panel used to call the quoter from the
 * browser via public Arc RPCs; those hang or SSL-fail, the catch swallowed it,
 * and "You receive" stayed 0 while wallet balance (wagmi) still loaded.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { quoteArcBuy, quoteArcSell, formatUsdc, parseUsdc } from '@/lib/arc-swap'
import { formatToken, parseToken } from '@/lib/token-format'
import { ARC } from '@/lib/contracts-arc'
import { limitOr429 } from '@/lib/rate-limit'
import { summarizeRpcError } from '@/lib/rpc-error'
import { jsonSafe } from '@/lib/json-safe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'arc-quote', 40, 60)
  if (limited) return limited

  const sp = req.nextUrl.searchParams
  const token = (sp.get('token') || '').trim()
  const side = (sp.get('side') || '').trim().toLowerCase()
  const amount = (sp.get('amount') || '').trim()
  if (!isAddress(token) || (side !== 'buy' && side !== 'sell') || !amount) {
    return NextResponse.json({ ok: false, error: 'invalid quote' }, { status: 400 })
  }
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) {
    return NextResponse.json({ ok: false, error: 'invalid amount' }, { status: 400 })
  }

  try {
    if (side === 'buy') {
      const inAmt = parseUsdc(amount)
      if (inAmt <= 0n) return NextResponse.json({ ok: false, error: 'invalid amount' }, { status: 400 })
      const out = await quoteArcBuy(token, inAmt, sp.get('ref') || '')
      if (out == null) {
        return NextResponse.json({
          ok: false,
          error: 'No quote for this size. Try a smaller amount.',
        })
      }
      return jsonSafe({
        ok: true,
        out: out.toString(),
        formatted: formatToken(out, ARC.TOKEN_DECIMALS),
      })
    }

    const inAmt = parseToken(amount, ARC.TOKEN_DECIMALS)
    if (inAmt <= 0n) return NextResponse.json({ ok: false, error: 'invalid amount' }, { status: 400 })
    const out = await quoteArcSell(token, inAmt)
    if (out == null) {
      return NextResponse.json({
        ok: false,
        error: 'No quote for this size. Try a smaller amount.',
      })
    }
    return jsonSafe({
      ok: true,
      out: out.toString(),
      formatted: formatUsdc(out),
    })
  } catch (e) {
    console.error('[api/arc/quote]', summarizeRpcError(e))
    return NextResponse.json({ ok: false, error: 'Quote failed. Arc RPC is busy — retry.' }, { status: 502 })
  }
}
