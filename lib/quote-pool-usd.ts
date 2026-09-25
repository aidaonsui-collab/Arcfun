/**
 * USD per 1 whole quote token, read from that token's own USDC v4 pool.
 * Used for custom quotes that are not on a Coinbase spot (UpSideDownCat).
 */
import type { Hex } from 'viem'
import { arcPublicClient } from './contracts-arc'
import { readEveV4SqrtPriceX96 } from './arc-v4-swap'
import { usdcPerTokenFromSqrtX96 } from './arc-instant-tokens'

export async function fetchQuotePoolUsd(opts: {
  poolId: Hex
  tokenIsCurrency0: boolean
  tokenDecimals: number
  quoteDecimals?: number
}): Promise<number | null> {
  try {
    const sqrt = await readEveV4SqrtPriceX96(opts.poolId, arcPublicClient())
    const px = usdcPerTokenFromSqrtX96(
      sqrt,
      opts.tokenIsCurrency0,
      opts.tokenDecimals,
      opts.quoteDecimals ?? 6,
    )
    return px > 0 && Number.isFinite(px) ? px : null
  } catch {
    return null
  }
}
