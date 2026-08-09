/**
 * Arc Instant Reflection (USDC-quoted) — InstantReflectionUsdcFactory.
 * Pair: TOKEN / USDC. Creation fee: native USDC. First buy: ERC-20 USDC pull.
 */
import type { Address } from 'viem'
import { parseUnits } from 'viem'
import { ARC, ARC_CHAIN_ID, arcReflectionEnabled } from './contracts-arc'

export const INSTANT_REFLECTION_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createTokenReflectionInstant',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'rewardToken', type: 'address' },
      { name: 'firstBuyUsdc6', type: 'uint256' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createTokenReflectionInstantTo',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'rewardToken', type: 'address' },
      { name: 'firstBuyUsdc6', type: 'uint256' },
      { name: 'creatorRewardsWallet', type: 'address' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'CREATION_FEE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'QUOTE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'allTokensLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allTokens',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'event',
    name: 'InstantReflectionCreated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'rewardToken', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
      { name: 'feeSink', type: 'address', indexed: false },
    ],
  },
] as const

export type ArcReflectionWriteCall = {
  address: Address
  abi: typeof INSTANT_REFLECTION_FACTORY_ABI
  functionName: string
  args: unknown[]
  value?: bigint
  chainId: number
}

/** USDC 6dp first-buy (same as Instant meme). */
export function parseArcUsdc(v: string | number): bigint {
  return parseUnits(String(v || '0'), 6)
}

/**
 * createTokenReflectionInstant / createTokenReflectionInstantTo
 * value = CREATION_FEE only (native). First buy is ERC-20 USDC approve + pull.
 */
export function buildCreateTokenReflectionArc(
  name: string,
  symbol: string,
  rewardToken: Address,
  firstBuyUsdc6: bigint,
  creationFeeWei: bigint,
  creatorRewardsWallet?: Address | null,
): ArcReflectionWriteCall {
  if (!arcReflectionEnabled()) throw new Error('Arc Instant Reflection factory not configured')
  const rewards =
    creatorRewardsWallet && creatorRewardsWallet !== '0x0000000000000000000000000000000000000000'
      ? creatorRewardsWallet
      : null
  if (rewards) {
    return {
      address: ARC.REFLECTION_FACTORY,
      abi: INSTANT_REFLECTION_FACTORY_ABI,
      functionName: 'createTokenReflectionInstantTo',
      args: [name, symbol, rewardToken, firstBuyUsdc6, rewards],
      value: creationFeeWei > 0n ? creationFeeWei : undefined,
      chainId: ARC_CHAIN_ID,
    }
  }
  return {
    address: ARC.REFLECTION_FACTORY,
    abi: INSTANT_REFLECTION_FACTORY_ABI,
    functionName: 'createTokenReflectionInstant',
    args: [name, symbol, rewardToken, firstBuyUsdc6],
    value: creationFeeWei > 0n ? creationFeeWei : undefined,
    chainId: ARC_CHAIN_ID,
  }
}

export const ARC_REFLECTION_CREATE_GAS = 14_000_000n
