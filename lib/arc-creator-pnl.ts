/**
 * Approximate trading PnL for a wallet across a set of ArcFun tokens (recent tape only).
 * Uses each token's recent Swap tape (capped) — not full history.
 */
import type { Address } from 'viem'
import { fetchArcTrades } from './arc-trades'
import type { PoolToken } from './tokens'

export type CreatorPnl = {
  /** Net realized-ish: sellUsd - buyUsd on recent tape */
  realizedUsd: number
  buyVolumeUsd: number
  sellVolumeUsd: number
  buyCount: number
  sellCount: number
  /** Rough: sells - buys; negative means more bought than sold in window */
  netFlowUsd: number
  tokensSampled: number
  tradesSampled: number
  note: string
  range: '1D' | '1W' | '1M' | 'ALL'
}

const RANGE_SEC: Record<CreatorPnl['range'], number | null> = {
  '1D': 86_400,
  '1W': 7 * 86_400,
  '1M': 30 * 86_400,
  ALL: null,
}

export async function computeCreatorPnl(
  wallet: string,
  tokens: PoolToken[],
  range: CreatorPnl['range'] = '1W',
): Promise<CreatorPnl> {
  const w = wallet.toLowerCase()
  const cutoff = RANGE_SEC[range] != null ? Math.floor(Date.now() / 1000) - (RANGE_SEC[range] as number) : 0

  // Cap tokens sampled to keep RPC cost bounded
  const sample = tokens.slice(0, 12)
  let buyVolumeUsd = 0
  let sellVolumeUsd = 0
  let buyCount = 0
  let sellCount = 0
  let tradesSampled = 0

  await Promise.all(
    sample.map(async (t) => {
      const addr = (t.coinType || t.poolId) as Address
      if (!addr?.startsWith?.('0x')) return
      try {
        const tape = await fetchArcTrades(addr)
        for (const tr of tape.trades ?? []) {
          if (tr.trader.toLowerCase() !== w) continue
          if (cutoff && tr.ts < cutoff) continue
          tradesSampled++
          if (tr.isBuy) {
            buyCount++
            buyVolumeUsd += tr.valueUsd || 0
          } else {
            sellCount++
            sellVolumeUsd += tr.valueUsd || 0
          }
        }
      } catch {
        /* skip token */
      }
    }),
  )

  const realizedUsd = sellVolumeUsd - buyVolumeUsd
  return {
    realizedUsd,
    buyVolumeUsd,
    sellVolumeUsd,
    buyCount,
    sellCount,
    netFlowUsd: sellVolumeUsd - buyVolumeUsd,
    tokensSampled: sample.length,
    tradesSampled,
    note: 'Approx from recent on-chain swaps only (not full history / cost-basis).',
    range,
  }
}
