import { formatUnits, parseUnits } from 'viem'
import { ARC } from './contracts-arc'

/**
 * Instant / Reflection launch tokens are LaunchToken18. A prior copy of this helper
 * used 6dp (Robinpad USDC-style), which made buy quotes look 1e12 too large
 * (70 USDC → "2782591296703107537 EVE" instead of ~2.78M).
 *
 * Pass `decimals` from token.decimals() when the panel has it; default 18.
 */
export const DEFAULT_TOKEN_DECIMALS = ARC.TOKEN_DECIMALS

export const parseToken = (v: string | number, decimals: number = DEFAULT_TOKEN_DECIMALS) =>
  parseUnits(String(v), decimals)
export const formatToken = (v: bigint, decimals: number = DEFAULT_TOKEN_DECIMALS) =>
  formatUnits(v, decimals)
