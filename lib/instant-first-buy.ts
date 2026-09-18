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

/** Listed Instant FDV = virtual quote (in USD) × 1e9 / VIRTUAL_TOKEN_INIT. */
export function instantListedMcUsd(opts: {
  virtualQuoteRaw: bigint
  quoteDecimals?: number
  usdPerQuote?: number
}): number {
  const vq = opts.virtualQuoteRaw
  if (vq <= 0n) return 0
  const dec = opts.quoteDecimals && opts.quoteDecimals > 0 ? opts.quoteDecimals : 6
  const usd = opts.usdPerQuote != null && Number.isFinite(opts.usdPerQuote) ? opts.usdPerQuote : 1
  if (!(usd > 0)) return 0
  const vti = Number(formatUnits(VIRTUAL_TOKEN_INIT_18, 18))
  const quoteHuman = Number(formatUnits(vq, dec))
  if (!(vti > 0) || !(quoteHuman > 0)) return 0
  const mc = (quoteHuman * usd * 1_000_000_000) / vti
  return Number.isFinite(mc) && mc > 0 ? mc : 0
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
