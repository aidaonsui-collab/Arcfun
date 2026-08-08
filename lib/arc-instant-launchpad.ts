/**
 * Arc Instant (USDC-quoted) — InstantErc20QuoteFactory on Arc mainnet.
 * Same ABI as RH ERC-20 quote Instant; first-buy is USDC 6dp (approve + pull).
 */
import type { Address } from 'viem'
import { parseUnits } from 'viem'
import { ARC, ARC_CHAIN_ID, arcInstantEnabled } from './contracts-arc'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'

export { INSTANT_QUOTE_FACTORY_ABI }

export type ArcInstantWriteCall = {
  address: Address
  abi: typeof INSTANT_QUOTE_FACTORY_ABI
  functionName: string
  args: unknown[]
  value?: bigint
  chainId: number
}

export function arcInstantFactory(): Address {
  if (!arcInstantEnabled()) throw new Error('Arc Instant factory not configured')
  return ARC.INSTANT_FACTORY
}

/** USDC 6dp first-buy amount. */
export function parseArcUsdc(v: string | number): bigint {
  return parseUnits(String(v || '0'), 6)
}

/**
 * createTokenMemeInstantQuote — first buy in USDC (approve factory first when > 0).
 * `value` = CREATION_FEE only (native USDC 18dp); firstBuy is ERC-20 pull.
 */
export function buildCreateTokenMemeInstantArc(
  name: string,
  symbol: string,
  firstBuyUsdc6: bigint,
  creationFeeWei: bigint,
): ArcInstantWriteCall {
  return {
    address: arcInstantFactory(),
    abi: INSTANT_QUOTE_FACTORY_ABI,
    functionName: 'createTokenMemeInstantQuote',
    args: [name, symbol, firstBuyUsdc6],
    value: creationFeeWei > 0n ? creationFeeWei : undefined,
    chainId: ARC_CHAIN_ID,
  }
}

/** Fixed gas for Instant create — avoids public-RPC eth_estimateGas -32005 failures. */
export { ARC_INSTANT_CREATE_GAS } from './contracts-arc'
