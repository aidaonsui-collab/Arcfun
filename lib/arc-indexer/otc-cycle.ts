/**
 * OTC book tick — OfferCreated catch-up + live offers() refresh + desk stats.
 * Owned by Jessica's Air (lib/arc-indexer/daemon.ts). HTTP route is a manual trigger only.
 */
import { parseAbiItem, type Address, type Hex } from 'viem'
import { arcPublicClient } from '@/lib/contracts-arc'
import {
  loadState,
  saveState,
  listOtcOffers,
  otcOfferCount,
  upsertOtcOffer,
  removeOtcOffer,
} from '@/lib/arc-indexer/store'
import { scanLogsChunked } from '@/lib/arc-indexer/logs'
import { catchUpOtcDeskStats } from '@/lib/arc-indexer/otc-desk-stats'
import { ROBIN_OTC_LIQUIDITY, LIQUIDITY_ABI, robinOtcEnabled } from '@/lib/bridge/robin-otc'

const OFFER_CREATED = parseAbiItem(
  'event OfferCreated(bytes32 indexed offerId, address indexed maker, address sellerPayment, uint32 premiumBps, uint256 amount)',
)
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const OTC_FLOOR = 14_000_000n
const OTC_OFFER_ZERO_REMOVE_MS = 40 * 60 * 1000

export type OtcIndexerCycleResult = {
  ok: boolean
  ms: number
  found?: number
  refreshed?: number
  otcOfferCount?: number
  otcCursor?: string
  head?: string
  error?: string
  deskStats?: { settledTrades: number; volumeUsdc: string; complete: boolean } | null
}

export async function runOtcIndexerCycle(): Promise<OtcIndexerCycleResult> {
  if (!robinOtcEnabled() || ROBIN_OTC_LIQUIDITY === ZERO) {
    return { ok: false, ms: 0, error: 'otc not configured' }
  }
  const t0 = Date.now()
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
      maxChunks: 40,
    })
    for (const log of logs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (log as { args?: any }).args as {
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

  const knownBefore = await listOtcOffers()
  if (knownBefore.length === 0) {
    const last = state.otcEmptyRescanAt || 0
    if (Date.now() - last > 6 * 60 * 60 * 1000) {
      const back = head > 1_000_000n ? head - 1_000_000n : OTC_FLOOR
      const cur = BigInt(state.otcCursor || '0')
      if (cur > back) {
        state.otcCursor = back.toString()
        state.otcEmptyRescanAt = Date.now()
      }
    }
  }

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
      if (!active) {
        await removeOtcOffer(o.offerId)
      } else if (remaining === 0n) {
        const zeroSince = o.remainingZeroSince ?? Date.now()
        if (Date.now() - zeroSince >= OTC_OFFER_ZERO_REMOVE_MS) {
          await removeOtcOffer(o.offerId)
        } else {
          await upsertOtcOffer({
            offerId: o.offerId,
            maker,
            sellerPayment,
            premiumBps: Number(premiumBps),
            remaining: '0',
            active,
            createdBlock: o.createdBlock,
            updatedAt: Date.now(),
            remainingZeroSince: zeroSince,
          })
        }
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

  const latest = await loadState()
  const prevRun = latest.lastRun
  await saveState({
    ...latest,
    otcCursor: state.otcCursor,
    otcEmptyRescanAt: state.otcEmptyRescanAt,
    updatedAt: Date.now(),
    lastRun: {
      at: Date.now(),
      ok: true,
      ms: Date.now() - t0,
      factories: prevRun?.factories ?? 0,
      otcOffers: found,
      swapsTokens: prevRun?.swapsTokens ?? 0,
      worker: prevRun?.worker,
    },
  })

  return {
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
  }
}
