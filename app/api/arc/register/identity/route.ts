/**
 * POST /api/arc/register/identity — writes name/symbol/creator/pool straight from chain reads.
 * No signature. Every value here is derived from contract state the caller cannot influence —
 * name/symbol are ERC-20 reads on the token itself, creator/pool come from readPadCreator's
 * on-chain factory lookup — so there is nothing to authenticate. Anyone calling this for a given
 * token just gets the same already-public on-chain truth written into the cache; the response
 * is identical no matter who asks.
 *
 * Split out from the signed POST /api/arc/register (2026-08) after tracing every consumer of
 * getArcTokenMeta (lib/arc-instant-tokens.ts x3, lib/port/origin-token.ts) and finding none of
 * them read name/symbol/creator from KV at all — every one already re-derives them live from
 * chain regardless of KV state, unconditionally. So a failed/declined signature on the OTHER
 * route (see submitRegister in ArcCreateForm.tsx) never actually left a token nameless — the
 * "Lazy Chameleon" token that motivated this split displayed its real name and symbol the whole
 * time despite `meta: null`, purely from that existing chain fallback.
 *
 * What this endpoint actually buys: the KV record stops being fully empty for a launched token,
 * which is a real (if narrower-than-first-assumed) correctness/consistency win, and it means the
 * create flow can populate SOMETHING with zero wallet friction and zero failure mode, before ever
 * asking for the signature that genuinely is required — for image/description/socials, which are
 * arbitrary content with nothing on-chain to check them against. That part stays fully gated
 * behind POST /api/arc/register; this endpoint never touches it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { erc20Abi, type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { readPadCreator } from '@/lib/port/origin-token'
import { setArcTokenMeta } from '@/lib/arc-token-meta'
import { arcPublicClient } from '@/lib/contracts-arc'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'arc-register-identity', 20)
  if (limited) return limited

  const body = (await req.json().catch(() => ({}))) as { token?: string; pool?: string }
  const token = body.token
  if (!token || !isPlausibleEvmAddress(token)) {
    return NextResponse.json({ ok: false, error: 'invalid token' }, { status: 400 })
  }

  // Same chain-derived check every other consumer uses — never trusts the request body.
  const creator = await readPadCreator(token as Address)
  if (!creator) {
    return NextResponse.json({ ok: false, error: 'not an ArcFun launch' }, { status: 404 })
  }

  const client = arcPublicClient()
  let name: string
  let symbol: string
  try {
    ;[name, symbol] = await Promise.all([
      client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'symbol' }),
    ])
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not read token identity: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }

  const pool = body.pool && isPlausibleEvmAddress(body.pool) ? body.pool : undefined

  try {
    await setArcTokenMeta(token, { name, symbol, creator, pool, instantLaunch: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'could not save token identity' }, { status: 503 })
  }

  return NextResponse.json({ ok: true, name, symbol, creator })
}
