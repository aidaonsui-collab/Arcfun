/**
 * Create-form first-buy preview. Instant seed is virtual quote × VIRTUAL_TOKEN_INIT
 * (LaunchToken18). EveFeeHook takes the pool fee on output.
 */
import { formatUnits } from 'viem'
import { ARC } from './contracts-arc'

const VIRTUAL_TOKEN_INIT_18 = ARC.VIRTUAL_TOKEN_INIT
const VIRTUAL_TOKEN_INIT_6 = 1_066_666_666_666_666n

function virtualTokenInit(tokenDecimals: number): bigint {
  return tokenDecimals >= 18 ? VIRTUAL_TOKEN_INIT_18 : VIRTUAL_TOKEN_INIT_6
}

export function estimateInstantFirstBuyTokens(opts: {
  quoteInRaw: bigint
  virtualQuoteRaw: bigint
  tokenDecimals?: number
  feeBps?: number
}): number {
  const quoteIn = opts.quoteInRaw
  const vq = opts.virtualQuoteRaw
  if (quoteIn <= 0n || vq <= 0n) return 0
  const dec = opts.tokenDecimals && opts.tokenDecimals > 0 ? opts.tokenDecimals : 18
  const vti = virtualTokenInit(dec)
  const denom = vq + quoteIn
  if (denom <= 0n) return 0
  const gross = (vti * quoteIn) / denom
  const fee = Number.isFinite(opts.feeBps) ? Math.min(Math.max(0, Math.floor(opts.feeBps!)), 10_000) : 0
  const net = fee > 0 ? (gross * BigInt(10_000 - fee)) / 10_000n : gross
  if (net <= 0n) return 0
  const human = Number(formatUnits(net, dec))
  return Number.isFinite(human) && human > 0 ? human : 0
}
