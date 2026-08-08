import type { Address } from 'viem'

/**
 * Trade/price types — trimmed from Robinpad's `lib/evm-trades.ts` to just the shapes
 * `lib/arc-trades.ts` (kept verbatim from that codebase) imports. The upstream file's actual
 * `fetchEvmTrades()` implementation is RH4663/Monad/Stable event-scanning logic that Arc doesn't
 * use — `lib/arc-trades.ts` has its own Arc-specific scanner and builds these types directly.
 */
export const EVM_MAX_TRADES = 600

export interface EvmTrade {
  trader: Address
  isBuy: boolean
  tokenAmount: number
  nativeAmount: number
  valueUsd: number
  price: number
  openPrice?: number
  priceUsd: number
  ts: number
  blockNumber: number
  txHash: `0x${string}`
}

export interface EvmTradeStats {
  txns: number
  buys: number
  sells: number
  volumeUsd: number
  buyVolUsd: number
  sellVolUsd: number
  traders: number
  buyers: number
  sellers: number
}

export interface PricePoint {
  time: number
  value: number
  isBuy?: boolean
  nativeAmount?: number
}

export interface EvmTradesResult {
  trades: EvmTrade[]
  stats: EvmTradeStats
  pricePoints: PricePoint[]
}
