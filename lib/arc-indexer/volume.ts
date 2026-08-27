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
import { arcPublicClient } from '@/lib/contracts-arc'
import { sumSwapUsd } from '@/lib/arc-trades'

const tradesKvKey = (token: string) => `arcfun:trades:${token.toLowerCase()}`

const HOUR = 3600
const FACTORY_FLOOR = 14_000_000n
const LOG_CHUNK = 9_000n
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

  let volume1h = 0
  let volume6h = 0
  let volume12h = 0
  let volume24h = 0
  let tapeSum = 0
  let lastTradeAt = 0

  for (const t of trades) {
    const ts = t.ts || 0
    const usd = t.valueUsd || 0
    if (ts > lastTradeAt) lastTradeAt = ts
    if (ts <= 0 || usd <= 0) continue
    tapeSum += usd
    const age = now - ts
    if (age <= 24 * HOUR) volume24h += usd
    if (age <= 12 * HOUR) volume12h += usd
    if (age <= 6 * HOUR) volume6h += usd
    if (age <= HOUR) volume1h += usd
  }

  const prev = await getVolume(token)
  let volumeAll = prev?.volumeAll ?? 0
  let downTo = prev?.volumeAllDownTo ? BigInt(prev.volumeAllDownTo) : null
  let upTo = prev?.volumeAllUpTo ? BigInt(prev.volumeAllUpTo) : null

  try {
    const head = await arcPublicClient().getBlockNumber()
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
    priceChange24h: priceChangeFromTrades(trades),
    sparkCloses: sparkClosesFromTrades(trades),
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
