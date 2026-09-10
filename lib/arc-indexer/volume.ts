/**
 * Volume windows from persisted trade tape (arcfun:trades:*).
 * Lifetime volume walks Uni V3 Swap logs in 9k chunks (RPC getLogs cap is 10k).
 */
import { kv } from '@vercel/kv'
import type { Address } from 'viem'
import type { EvmTrade } from '@/lib/evm-trades'
import { priceChangeFromTrades, sparkClosesFromTrades } from '@/lib/candles'
import type { IndexedVolume } from './types'
import { getVolume, setVolume } from './store'
import { summarizeRpcError } from '@/lib/rpc-error'
import { arcLogsClient } from '@/lib/contracts-arc'
import { sumSwapUsd, fetchOnChain24hSwaps, TRADES_CAP } from '@/lib/arc-trades'

const tradesKvKey = (token: string) => `arcfun:trades:${token.toLowerCase()}`

const HOUR = 3600

/** Sum USD volume per rolling window from a trade list, plus the newest trade's timestamp. */
export function bucketVolumeWindows(
  list: Pick<EvmTrade, 'ts' | 'valueUsd'>[],
  nowSec: number,
): { volume1h: number; volume6h: number; volume12h: number; volume24h: number; lastTradeAt: number } {
  let volume1h = 0
  let volume6h = 0
  let volume12h = 0
  let volume24h = 0
  let lastTradeAt = 0
  for (const t of list) {
    const ts = t.ts || 0
    const usd = t.valueUsd || 0
    if (ts > lastTradeAt) lastTradeAt = ts
    if (ts <= 0 || usd <= 0) continue
    const age = nowSec - ts
    if (age <= 24 * HOUR) volume24h += usd
    if (age <= 12 * HOUR) volume12h += usd
    if (age <= 6 * HOUR) volume6h += usd
    if (age <= HOUR) volume1h += usd
  }
  return { volume1h, volume6h, volume12h, volume24h, lastTradeAt }
}

/**
 * True when the KV tape (capped at `cap`) is full AND its oldest entry is still inside the 24h
 * window — meaning the tape no longer spans a full day, so any window metric derived purely from
 * it undercounts. Those tokens need the on-chain rescan; everything else stays on the tape.
 * `trades` is oldest→newest (KV lrange order).
 */
export function tapeSaturatedInWindow(
  trades: Pick<EvmTrade, 'ts'>[],
  nowSec: number,
  cap: number,
): boolean {
  if (trades.length < cap) return false
  const oldestTs = trades[0]?.ts ?? 0
  return oldestTs > nowSec - 24 * HOUR
}
const FACTORY_FLOOR = 14_000_000n
const LOG_CHUNK = 9_000n
/** How long a capped token's on-chain window rescan is trusted before it's redone. Shorter than
 *  the 2-min cron so a token still refreshes every cycle, but long enough that an opportunistic
 *  seedLifetimeVolume() call right after a cron tick reuses the result instead of rescanning. */
const ONCHAIN_RESCAN_TTL_MS = 90_000
/** Newest-first windows per compute so all-time pulls ahead of 24h on the first pass. */
const LIFETIME_CHUNKS = 16

export async function computeVolumeWindows(token: Address | string): Promise<IndexedVolume> {
  const now = Math.floor(Date.now() / 1000)
  let trades: EvmTrade[] = []
  try {
    // Last ~400 trades (newest at end of list)
    trades = (await kv.lrange<EvmTrade>(tradesKvKey(String(token)), -400, -1)) ?? []
  } catch (e) {
    console.warn('[arc-indexer] volume read trades', summarizeRpcError(e))
  }

  const prev = await getVolume(token)

  let tapeSum = 0
  for (const t of trades) {
    if ((t.ts || 0) > 0 && (t.valueUsd || 0) > 0) tapeSum += t.valueUsd
  }

  const w = bucketVolumeWindows(trades, now)
  let volume1h = w.volume1h
  let volume6h = w.volume6h
  let volume12h = w.volume12h
  let volume24h = w.volume24h
  let lastTradeAt = w.lastTradeAt

  let priceChange24h = priceChangeFromTrades(trades)
  let sparkCloses = sparkClosesFromTrades(trades)

  // The tape is capped at TRADES_CAP. When it no longer spans a full day, the windows above only
  // cover the most recent TRADES_CAP swaps — a high-frequency token (a fresh launch mid-surge,
  // anything trending) then reads well under its real 24h volume, and the pad-wide total + the
  // "Top volume" sort inherit that. Rescan the real block range for those tokens; the low-volume
  // long tail keeps the free tape-only path above.
  if (tapeSaturatedInWindow(trades, now, TRADES_CAP)) {
    // The ~26h rescan is ~6s of getLogs. The cron hits this token every ~2min and the windows
    // barely move in that time, so if the last stored windows are recent and already ahead of the
    // tape, carry them forward instead of rescanning every cycle.
    const prevFresh =
      !!prev?.updatedAt &&
      Date.now() - prev.updatedAt < ONCHAIN_RESCAN_TTL_MS &&
      (prev.volume24h ?? 0) >= volume24h
    if (prevFresh) {
      volume1h = Math.max(volume1h, prev!.volume1h ?? 0)
      volume6h = Math.max(volume6h, prev!.volume6h ?? 0)
      volume12h = Math.max(volume12h, prev!.volume12h ?? 0)
      volume24h = Math.max(volume24h, prev!.volume24h ?? 0)
      lastTradeAt = Math.max(lastTradeAt, prev!.lastTradeAt ?? 0)
      tapeSum = Math.max(tapeSum, prev!.volume24h ?? 0)
      if (prev!.priceChange24h != null) priceChange24h = prev!.priceChange24h
      if (prev!.sparkCloses?.length) sparkCloses = prev!.sparkCloses
    } else {
      try {
        const chain = await fetchOnChain24hSwaps(token as Address)
        if (chain && chain.length >= trades.length) {
          const c = bucketVolumeWindows(chain, now)
          // Floor against the tape — never regress below what the tape already proved.
          volume1h = Math.max(volume1h, c.volume1h)
          volume6h = Math.max(volume6h, c.volume6h)
          volume12h = Math.max(volume12h, c.volume12h)
          volume24h = Math.max(volume24h, c.volume24h)
          lastTradeAt = Math.max(lastTradeAt, c.lastTradeAt)
          tapeSum = Math.max(tapeSum, c.volume24h)
          priceChange24h = priceChangeFromTrades(chain)
          sparkCloses = sparkClosesFromTrades(chain)
        }
      } catch (e) {
        console.warn('[arc-indexer] on-chain 24h windows', summarizeRpcError(e))
      }
    }
  }

  let volumeAll = prev?.volumeAll ?? 0
  let downTo = prev?.volumeAllDownTo ? BigInt(prev.volumeAllDownTo) : null
  let upTo = prev?.volumeAllUpTo ? BigInt(prev.volumeAllUpTo) : null

  try {
    const head = await arcLogsClient().getBlockNumber()
    if (upTo != null && upTo < head) {
      volumeAll += await sumSwapUsd(token as Address, upTo + 1n, head)
      upTo = head
    }
    const cursor = downTo ?? head
    if (cursor > FACTORY_FLOOR) {
      const span = LOG_CHUNK * BigInt(LIFETIME_CHUNKS)
      const from = cursor > FACTORY_FLOOR + span - 1n ? cursor - span + 1n : FACTORY_FLOOR
      volumeAll += await sumSwapUsd(token as Address, from, cursor)
      downTo = from > FACTORY_FLOOR ? from - 1n : FACTORY_FLOOR
      if (upTo == null) upTo = cursor
    }
  } catch (e) {
    console.warn('[arc-indexer] lifetime volume', summarizeRpcError(e))
  }

  volumeAll = Math.max(volumeAll, tapeSum, prev?.volumeAll ?? 0)

  return {
    volume1h,
    volume6h,
    volume12h,
    volume24h,
    volumeAll,
    volumeAllDownTo: downTo != null ? downTo.toString() : prev?.volumeAllDownTo,
    volumeAllUpTo: upTo != null ? upTo.toString() : prev?.volumeAllUpTo,
    lastTradeAt,
    updatedAt: Date.now(),
    priceChange24h,
    sparkCloses,
  }
}

export async function seedLifetimeVolume<
  T extends { coinType?: string; poolId?: string; volume24h?: number; volumeAll?: number },
>(tokens: T[], n = 3): Promise<T[]> {
  const stale = [...tokens]
    .filter((t) => (t.volumeAll ?? 0) <= (t.volume24h ?? 0) + 1)
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, n)
  if (stale.length === 0) return tokens
  for (const t of stale) {
    const id = (t.coinType || t.poolId || '').toLowerCase()
    if (!id.startsWith('0x')) continue
    try {
      const vol = await computeVolumeWindows(id)
      await setVolume(id, vol)
      t.volumeAll = vol.volumeAll
      if (vol.volume24h) t.volume24h = vol.volume24h
    } catch (e) {
      console.warn('[arc-indexer] seed lifetime', id, summarizeRpcError(e))
    }
  }
  return tokens
}
