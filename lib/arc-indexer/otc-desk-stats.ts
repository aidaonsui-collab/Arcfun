/**
 * Lifetime OTC settled-trades / volume.
 *
 * The desk UI used to scan FillSettled in the browser over a ~5 day window.
 * That goes to 0 as soon as the last fill ages out of the window (live 2026-08-18:
 * 10 Base fills, last at Base block 49903889, ~7 days old → "Settled trades: 0").
 * mainnet.base.org also now rejects eth_getLogs ranges over 10_000 blocks, so the
 * previous 220k one-shot never landed.
 *
 * Cron catch-up scans forward from a deployment floor in 10k chunks, persists
 * cumulative totals in KV, and the /otc page reads that instead of a lookback.
 */
import {
  livePaymentChains,
  paymentClient,
  PAYMENT_ABI,
  robinOtcEnabled,
  type OtcPaymentChain,
} from '@/lib/bridge/robin-otc'
import { loadOtcDeskStats, saveOtcDeskStats, type IndexedOtcDeskStats } from './store'
import { summarizeRpcError } from '@/lib/rpc-error'

/** Base public RPC: eth_getLogs limited to 10_000 (2026-08-18). */
const LOG_CHUNK = 10_000n
const MAX_CHUNKS_PER_CHAIN = 40

/**
 * First known Base FillSettled is 49_852_856. Floor sits a bit earlier so a
 * redeploy / missed create isn't clipped. ARB had no fills in the first weeks
 * of the desk; floor is ~3 weeks behind head at 0.25s/block.
 */
const SETTLED_FLOOR: Record<number, bigint> = {
  8453: 49_800_000n,
  42161: 488_000_000n,
  1: 22_800_000n,
}

export type OtcDeskStatsPublic = {
  settledTrades: number
  volumeUsdc: string
  complete: boolean
  updatedAt: number
}

export function toPublicStats(row: IndexedOtcDeskStats): OtcDeskStatsPublic {
  return {
    settledTrades: row.settledTrades,
    volumeUsdc: row.volumeUsdc,
    complete: row.complete,
    updatedAt: row.updatedAt,
  }
}

export async function getPublicOtcDeskStats(): Promise<OtcDeskStatsPublic | null> {
  const row = await loadOtcDeskStats()
  if (!row) return null
  return toPublicStats(row)
}

function emptyStats(): IndexedOtcDeskStats {
  return {
    settledTrades: 0,
    volumeUsdc: '0',
    settledCursor: {},
    complete: false,
    updatedAt: 0,
  }
}

function floorFor(chain: OtcPaymentChain): bigint {
  return SETTLED_FLOOR[chain.chainId] ?? 0n
}

let inFlight: Promise<IndexedOtcDeskStats | null> | null = null

/**
 * Incremental FillSettled catch-up on Base / ARB / ETH. Safe to call every
 * OTC indexer tick. Does not rewind: cursor only advances on contiguous success.
 */
export async function catchUpOtcDeskStats(opts?: {
  maxChunks?: number
}): Promise<IndexedOtcDeskStats | null> {
  if (!robinOtcEnabled()) return null
  if (inFlight) return inFlight
  inFlight = catchUpOtcDeskStatsInner(opts).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function catchUpOtcDeskStatsInner(opts?: {
  maxChunks?: number
}): Promise<IndexedOtcDeskStats | null> {

  const prev = (await loadOtcDeskStats()) ?? emptyStats()
  const settledCursor: Record<string, string> = { ...prev.settledCursor }
  const live = livePaymentChains()
  const maxChunks = opts?.maxChunks ?? MAX_CHUNKS_PER_CHAIN
  let allAtHead = live.length > 0
  let scanned = 0
  let passTrades = 0
  let passVolume = 0n

  await Promise.all(
    live.map(async (chain) => {
      const key = String(chain.chainId)
      try {
        const client = paymentClient(chain)
        const latest = await client.getBlockNumber()
        const cached = settledCursor[key] ? BigInt(settledCursor[key]) : null
        let from = cached != null ? cached + 1n : floorFor(chain)
        if (from > latest) {
          settledCursor[key] = latest.toString()
          return
        }

        let chunks = 0
        let stalled = false
        while (from <= latest && chunks < maxChunks) {
          const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
          try {
            const logs = await client.getContractEvents({
              address: chain.payment,
              abi: PAYMENT_ABI,
              eventName: 'FillSettled',
              fromBlock: from,
              toBlock: to,
            })
            for (const log of logs) {
              const proceeds = (log.args.proceeds as bigint) ?? 0n
              const fee = (log.args.fee as bigint) ?? 0n
              passTrades += 1
              passVolume += proceeds + fee
            }
            settledCursor[key] = to.toString()
            from = to + 1n
            chunks++
            scanned++
          } catch (e) {
            stalled = true
            allAtHead = false
            console.warn(
              '[otc-desk-stats]',
              chain.id,
              from.toString(),
              to.toString(),
              summarizeRpcError(e),
            )
            break
          }
        }
        if (stalled || from <= latest) allAtHead = false
      } catch (e) {
        allAtHead = false
        console.warn('[otc-desk-stats]', chain.id, summarizeRpcError(e))
      }
    }),
  )

  const settledTrades = prev.settledTrades + passTrades
  const volumeUsdc = BigInt(prev.volumeUsdc || '0') + passVolume

  const next: IndexedOtcDeskStats = {
    settledTrades,
    volumeUsdc: volumeUsdc.toString(),
    settledCursor,
    complete: allAtHead,
    updatedAt: Date.now(),
  }
  // Always persist so a partial catch-up still shows real history next paint.
  await saveOtcDeskStats(next)
  if (scanned > 0) {
    console.info(
      '[otc-desk-stats] trades=%s vol=%s complete=%s chunks=%s',
      next.settledTrades,
      next.volumeUsdc,
      next.complete,
      scanned,
    )
  }
  return next
}
