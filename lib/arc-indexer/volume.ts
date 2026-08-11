/**
 * Volume windows from persisted trade tape (arcfun:trades:*).
 */
import { kv } from '@vercel/kv'
import type { Address } from 'viem'
import type { EvmTrade } from '@/lib/evm-trades'
import type { IndexedVolume } from './types'
import { summarizeRpcError } from '@/lib/rpc-error'

const tradesKvKey = (token: string) => `arcfun:trades:${token.toLowerCase()}`

const HOUR = 3600

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
  let lastTradeAt = 0

  for (const t of trades) {
    const ts = t.ts || 0
    const usd = t.valueUsd || 0
    if (ts > lastTradeAt) lastTradeAt = ts
    if (ts <= 0 || usd <= 0) continue
    const age = now - ts
    if (age <= 24 * HOUR) volume24h += usd
    if (age <= 12 * HOUR) volume12h += usd
    if (age <= 6 * HOUR) volume6h += usd
    if (age <= HOUR) volume1h += usd
  }

  return {
    volume1h,
    volume6h,
    volume12h,
    volume24h,
    lastTradeAt,
    updatedAt: Date.now(),
  }
}
