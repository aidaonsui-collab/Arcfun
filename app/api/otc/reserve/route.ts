/**
 * POST /api/otc/reserve — buyer-authorized Arc reserve(), submitted by the keeper wallet.
 *
 * Cuts one on-chain signature off the buyer's OTC purchase flow: instead of switching to Arc and
 * signing reserve() themselves (a real Arc network switch + gas tx), the buyer signs a free
 * EIP-712 message authorizing this offer/amount, and the already-funded keeper wallet
 * (ARC_OTC_KEEPER_KEY, same one running lib/arc-otc-keeper.ts) submits the actual reserve() call.
 * The on-chain hard-reserve anti-oversell protection in RobinOtcLiquidity.sol is unchanged — this
 * only moves who signs/pays gas for that specific call, not what the contract enforces before
 * payment. See lib/bridge/robin-otc.ts's RESERVE_AUTH_TYPES for the exact signed shape.
 *
 * This route is the only thing standing between an arbitrary signed message and keeper gas spend,
 * so it guards in order (cheapest rejection first):
 *   1. shape/type validation
 *   2. deadline sanity (not expired, not absurdly far out)
 *   3. per-buyer rate limit (signing is free for the caller, so this is what actually bounds
 *      keeper gas exposure to abuse — generous enough for real retries, cheap to enforce)
 *   4. EIP-712 signature recovers to the claimed buyer
 *   5. salt has not been redeemed before (KV SET NX — single-use authorization)
 * Only after all of that does it touch the chain.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isHex, verifyTypedData, type Address, type Hex } from 'viem'
import { kv } from '@vercel/kv'
import { arcPublicClient, arcServerWalletClient, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  ROBIN_OTC_LIQUIDITY,
  LIQUIDITY_ABI,
  RESERVE_AUTH_TYPES,
  reserveAuthDomain,
  OTC_RESERVE_TTL_SEC,
  encodeEventTopics,
} from '@/lib/bridge/robin-otc'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_SEC = 10 * 60
/** Reject any signed authorization whose deadline is further out than this — the client sets a
 *  short deadline (see InstantOtcPanel.tsx) so a stale/replayed message can't linger. */
const MAX_AUTH_TTL_SEC = 5 * 60

function keeperKey(): Hex | null {
  const k = (process.env.ARC_OTC_KEEPER_KEY || process.env.ROBIN_OTC_KEEPER_KEY || '').trim()
  if (/^0x[a-fA-F0-9]{64}$/.test(k)) return k as Hex
  if (/^[a-fA-F0-9]{64}$/.test(k)) return `0x${k}` as Hex
  return null
}

type ReserveBody = {
  offerId?: unknown
  amount?: unknown
  buyer?: unknown
  deadline?: unknown
  salt?: unknown
  signature?: unknown
}

export async function POST(req: NextRequest) {
  let body: ReserveBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const { offerId, amount, buyer, deadline, salt, signature } = body || {}

  if (typeof offerId !== 'string' || !isHex(offerId) || offerId.length !== 66) {
    return NextResponse.json({ ok: false, error: 'invalid offerId' }, { status: 400 })
  }
  if (typeof buyer !== 'string' || !isAddress(buyer)) {
    return NextResponse.json({ ok: false, error: 'invalid buyer address' }, { status: 400 })
  }
  if (typeof salt !== 'string' || !isHex(salt) || salt.length !== 66) {
    return NextResponse.json({ ok: false, error: 'invalid salt' }, { status: 400 })
  }
  if (typeof signature !== 'string' || !isHex(signature)) {
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 400 })
  }

  let amountBig: bigint
  let deadlineBig: bigint
  try {
    amountBig = BigInt(amount as string)
    deadlineBig = BigInt(deadline as string)
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid amount/deadline' }, { status: 400 })
  }
  if (amountBig <= 0n) {
    return NextResponse.json({ ok: false, error: 'amount must be positive' }, { status: 400 })
  }

  const now = Math.floor(Date.now() / 1000)
  if (deadlineBig <= BigInt(now)) {
    return NextResponse.json({ ok: false, error: 'authorization expired — try again' }, { status: 400 })
  }
  if (deadlineBig > BigInt(now + MAX_AUTH_TTL_SEC)) {
    return NextResponse.json({ ok: false, error: 'deadline too far in the future' }, { status: 400 })
  }

  const key = keeperKey()
  if (!key) {
    console.error('[otc/reserve] ARC_OTC_KEEPER_KEY / ROBIN_OTC_KEEPER_KEY missing')
    return NextResponse.json(
      { ok: false, error: 'keeper not configured — ask the platform owner to set ARC_OTC_KEEPER_KEY' },
      { status: 500 },
    )
  }

  const rlKey = `arcfun:otc:reserveauth:rl:${buyer.toLowerCase()}`
  const count = await kv.incr(rlKey)
  if (count === 1) await kv.expire(rlKey, RATE_LIMIT_WINDOW_SEC)
  if (count > RATE_LIMIT_MAX) {
    return NextResponse.json({ ok: false, error: 'rate limited — try again shortly' }, { status: 429 })
  }

  const domain = reserveAuthDomain(ROBIN_OTC_LIQUIDITY, ARC_CHAIN_ID)
  const message = {
    offerId: offerId as Hex,
    amount: amountBig,
    buyer: buyer as Address,
    deadline: deadlineBig,
    salt: salt as Hex,
  }
  let valid = false
  try {
    valid = await verifyTypedData({
      address: buyer as Address,
      domain,
      types: RESERVE_AUTH_TYPES,
      primaryType: 'ReserveRequest',
      message,
      signature: signature as Hex,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `signature verify failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }
  if (!valid) {
    return NextResponse.json({ ok: false, error: 'signature does not match buyer' }, { status: 401 })
  }

  // Single-use — TTL matches the auth's own max lifetime so the KV entry never outlives what it
  // was protecting.
  const saltKey = `arcfun:otc:reserveauth:used:${salt.toLowerCase()}`
  const claimed = await kv.set(saltKey, '1', { nx: true, ex: MAX_AUTH_TTL_SEC + 60 })
  if (claimed !== 'OK') {
    return NextResponse.json({ ok: false, error: 'this authorization was already used' }, { status: 409 })
  }

  try {
    const wallet = arcServerWalletClient(key)
    const hash = await wallet.writeContract({
      account: wallet.account!,
      chain: wallet.chain,
      address: ROBIN_OTC_LIQUIDITY,
      abi: LIQUIDITY_ABI,
      functionName: 'reserve',
      args: [offerId as Hex, amountBig, OTC_RESERVE_TTL_SEC],
      gas: 250_000n,
    })

    const pub = arcPublicClient()
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') {
      return NextResponse.json({ ok: false, error: `reserve tx reverted: ${hash}` }, { status: 500 })
    }

    const topics = encodeEventTopics({ abi: LIQUIDITY_ABI, eventName: 'Reserved' })
    const topic0 = (topics[0] as string | undefined)?.toLowerCase()
    const log = receipt.logs.find(
      (l) => l.topics[0]?.toLowerCase() === topic0 && l.address.toLowerCase() === ROBIN_OTC_LIQUIDITY.toLowerCase(),
    )
    if (!log?.topics[1]) {
      return NextResponse.json(
        { ok: false, error: 'reserve succeeded but reservation id missing from logs' },
        { status: 500 },
      )
    }
    const reservationId = log.topics[1] as Hex

    return NextResponse.json({
      ok: true,
      reservationId,
      expiresAt: now + OTC_RESERVE_TTL_SEC,
      txHash: hash,
      keeper: wallet.account!.address,
    })
  } catch (e) {
    console.error('[otc/reserve]', e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
