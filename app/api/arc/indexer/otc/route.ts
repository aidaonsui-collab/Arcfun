/**
 * GET /api/arc/indexer/otc — lightweight OTC-only index tick (every minute).
 * Keeps the offer book warm without running full factory/swap catch-up.
 */
import { NextRequest, NextResponse } from 'next/server'
import { arcPublicClient } from '@/lib/contracts-arc'
import { loadState, saveState, listOtcOffers, otcOfferCount } from '@/lib/arc-indexer/store'
import { scanLogsChunked } from '@/lib/arc-indexer/logs'
import { upsertOtcOffer, removeOtcOffer } from '@/lib/arc-indexer/store'
import { catchUpOtcDeskStats } from '@/lib/arc-indexer/otc-desk-stats'
import {
  ROBIN_OTC_LIQUIDITY,
  LIQUIDITY_ABI,
  robinOtcEnabled,
} from '@/lib/bridge/robin-otc'
import { parseAbiItem, type Address, type Hex } from 'viem'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const OFFER_CREATED = parseAbiItem(
  'event OfferCreated(bytes32 indexed offerId, address indexed maker, address sellerPayment, uint32 premiumBps, uint256 amount)',
)
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const OTC_FLOOR = 14_000_000n

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!robinOtcEnabled() || ROBIN_OTC_LIQUIDITY === ZERO) {
    return NextResponse.json({ ok: false, error: 'otc not configured' }, { status: 404 })
  }

  const t0 = Date.now()
  try {
    const state = await loadState()
    const client = arcPublicClient()
    const head = await client.getBlockNumber()
    let cursor = BigInt(state.otcCursor || '0')
    if (cursor === 0n) cursor = OTC_FLOOR

    let found = 0
    if (cursor < head) {
      const from = cursor + 1n
      const { logs, scannedTo } = await scanLogsChunked(client, {
        address: ROBIN_OTC_LIQUIDITY,
        event: OFFER_CREATED,
        fromBlock: from,
        toBlock: head,
        maxChunks: 40, // ~360k blocks / min when behind
      })
      for (const log of logs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = (log as any).args as {
          offerId?: Hex
          maker?: Address
          sellerPayment?: Address
          premiumBps?: number
          amount?: bigint
        }
        if (!args?.offerId) continue
        await upsertOtcOffer({
          offerId: args.offerId,
          maker: args.maker || ZERO,
          sellerPayment: args.sellerPayment || ZERO,
          premiumBps: Number(args.premiumBps ?? 0),
          remaining: (args.amount ?? 0n).toString(),
          active: true,
          createdBlock: Number(log.blockNumber ?? 0n),
          updatedAt: Date.now(),
        })
        found++
      }
      state.otcCursor = scannedTo.toString()
    }

    // Refresh remaining/active for known offers (cheap offers() reads)
    const known = await listOtcOffers()
    let refreshed = 0
    for (const o of known) {
      try {
        const row = (await client.readContract({
          address: ROBIN_OTC_LIQUIDITY,
          abi: LIQUIDITY_ABI,
          functionName: 'offers',
          args: [o.offerId],
        })) as readonly [Address, Address, number, bigint, boolean]
        const [maker, sellerPayment, premiumBps, remaining, active] = row
        if (!active || remaining === 0n) {
          await removeOtcOffer(o.offerId)
        } else {
          await upsertOtcOffer({
            offerId: o.offerId,
            maker,
            sellerPayment,
            premiumBps: Number(premiumBps),
            remaining: remaining.toString(),
            active,
            createdBlock: o.createdBlock,
            updatedAt: Date.now(),
          })
        }
        refreshed++
      } catch {
        /* keep prior */
      }
    }

    const desk = await catchUpOtcDeskStats().catch((e) => {
      console.warn('[indexer/otc] desk stats', e instanceof Error ? e.message : e)
      return null
    })

    state.updatedAt = Date.now()
    state.lastRun = {
      at: Date.now(),
      ok: true,
      ms: Date.now() - t0,
      factories: 0,
      otcOffers: found,
      swapsTokens: 0,
    }
    await saveState(state)

    return NextResponse.json({
      ok: true,
      ms: Date.now() - t0,
      found,
      refreshed,
      otcOfferCount: await otcOfferCount(),
      otcCursor: state.otcCursor,
      head: head.toString(),
      deskStats: desk
        ? {
            settledTrades: desk.settledTrades,
            volumeUsdc: desk.volumeUsdc,
            complete: desk.complete,
          }
        : null,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
