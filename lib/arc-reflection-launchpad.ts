/**
 * Arc Instant Reflection factory — create + catalog helpers.
 * Factory: InstantReflectionFactory (Transparent proxy) on Arc 5042.
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
      { name: 'firstBuyEthWei', type: 'uint256' },
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
      { name: 'firstBuyEthWei', type: 'uint256' },
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
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'rewardToken', type: 'address' },
          { name: 'feeSink', type: 'address' },
          { name: 'uniPool', type: 'address' },
          { name: 'positionId', type: 'uint256' },
          { name: 'liquidity', type: 'uint128' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
        ],
      },
    ],
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

/** Native 18dp amount (Arc gas = USDC native). Used for creation fee + optional first buy. */
export function parseArcNative(v: string | number): bigint {
  return parseUnits(String(v || '0'), 18)
}

/**
 * createTokenReflectionInstant / createTokenReflectionInstantTo
 * msg.value = CREATION_FEE + firstBuyEthWei (native).
 * Pair is TOKEN/WETH; first buy spends native via router into the launch pool.
 */
export function buildCreateTokenReflectionArc(
  name: string,
  symbol: string,
  rewardToken: Address,
  firstBuyNativeWei: bigint,
  creationFeeWei: bigint,
  creatorRewardsWallet?: Address | null,
): ArcReflectionWriteCall {
  if (!arcReflectionEnabled()) throw new Error('Arc Instant Reflection factory not configured')
  const rewards =
    creatorRewardsWallet && creatorRewardsWallet !== '0x0000000000000000000000000000000000000000'
      ? creatorRewardsWallet
      : null
  const value = creationFeeWei + firstBuyNativeWei
  if (rewards) {
    return {
      address: ARC.REFLECTION_FACTORY,
      abi: INSTANT_REFLECTION_FACTORY_ABI,
      functionName: 'createTokenReflectionInstantTo',
      args: [name, symbol, rewardToken, firstBuyNativeWei, rewards],
      value: value > 0n ? value : undefined,
      chainId: ARC_CHAIN_ID,
    }
  }
  return {
    address: ARC.REFLECTION_FACTORY,
    abi: INSTANT_REFLECTION_FACTORY_ABI,
    functionName: 'createTokenReflectionInstant',
    args: [name, symbol, rewardToken, firstBuyNativeWei],
    value: value > 0n ? value : undefined,
    chainId: ARC_CHAIN_ID,
  }
}

/** Heavy create (token + sink + mint + lock) — skip eth_estimateGas on flaky public RPCs. */
export const ARC_REFLECTION_CREATE_GAS = 14_000_000n
