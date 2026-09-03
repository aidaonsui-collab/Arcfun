/**
 * POST /api/otc/reserve/release — keeper releases an Arc hard-reserve it created.
 *
 * Called from the buy flow when fillOffer fails after reserve() already landed
 * (out of gas, user reject, RPC drop). Without this, remaining drops to 0 for
 * the full 30m TTL and the offer vanishes from the book.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isHex, type Hex } from 'viem'
import { arcPublicClient, arcServerWalletClient } from '@/lib/contracts-arc'
import { ROBIN_OTC_LIQUIDITY, LIQUIDITY_ABI, robinOtcEnabled } from '@/lib/bridge/robin-otc'
import { removeOtcReservation } from '@/lib/arc-indexer/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

function keeperKey(): Hex | null {
  const k = (process.env.ARC_OTC_KEEPER_KEY || process.env.ROBIN_OTC_KEEPER_KEY || '').trim()
  if (/^0x[a-fA-F0-9]{64}$/.test(k)) return k as Hex
  if (/^[a-fA-F0-9]{64}$/.test(k)) return `0x${k}` as Hex
  return null
}

export async function POST(req: NextRequest) {
  if (!robinOtcEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let body: { reservationId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const reservationId = body.reservationId
  if (typeof reservationId !== 'string' || !isHex(reservationId) || reservationId.length !== 66) {
    return NextResponse.json({ ok: false, error: 'invalid reservationId' }, { status: 400 })
  }
  if (reservationId.toLowerCase() === ZERO_BYTES32) {
    return NextResponse.json({ ok: false, error: 'empty reservationId' }, { status: 400 })
  }

  const key = keeperKey()
  if (!key) {
    return NextResponse.json({ ok: false, error: 'keeper not configured' }, { status: 500 })
  }

  try {
    const pub = arcPublicClient()
    const row = (await pub.readContract({
      address: ROBIN_OTC_LIQUIDITY,
      abi: LIQUIDITY_ABI,
      functionName: 'reservations',
      args: [reservationId as Hex],
    })) as readonly [Hex, `0x${string}`, bigint, bigint, boolean, boolean]

    const [, reserver, , expiresAt, consumed, released] = row
    if (released || consumed) {
      await removeOtcReservation(reservationId as Hex)
      return NextResponse.json({ ok: true, skipped: true, reason: consumed ? 'consumed' : 'released' })
    }

    const wallet = arcServerWalletClient(key)
    const keeper = wallet.account!.address
    const now = Math.floor(Date.now() / 1000)
    const expired = Number(expiresAt) <= now
    if (!expired && reserver.toLowerCase() !== keeper.toLowerCase()) {
      return NextResponse.json(
        { ok: false, error: 'reservation still live and not owned by keeper' },
        { status: 403 },
      )
    }

    const hash = await wallet.writeContract({
      account: wallet.account!,
      chain: wallet.chain,
      address: ROBIN_OTC_LIQUIDITY,
      abi: LIQUIDITY_ABI,
      functionName: 'releaseReservation',
      args: [reservationId as Hex],
      gas: 150_000n,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') {
      return NextResponse.json({ ok: false, error: `release tx reverted: ${hash}` }, { status: 500 })
    }
    await removeOtcReservation(reservationId as Hex)
    return NextResponse.json({ ok: true, txHash: hash })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/done/i.test(msg)) {
      await removeOtcReservation(reservationId as Hex)
      return NextResponse.json({ ok: true, skipped: true, reason: 'already released' })
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
