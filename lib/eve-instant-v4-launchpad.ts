/**
 * Uniswap v4 Instant create + pool lookup (EveInstantV4Factory / shared EveFeeHook).
 */
import type { Address, Hex } from 'viem'
import { ARC, ARC_CHAIN_ID, arcInstantV4Enabled } from './contracts-arc'
import type { FeeSplit } from './eve-fee-split'

export const EVE_V4_TICK_SPACING = 200
/** Listed Instant meme FDV target. MC = VQ * 1e9 / VIRTUAL_TOKEN_INIT. */
export const INSTANT_MEME_TARGET_FDV_USD = 1500
/** USDC 6dp virtual quote so listed MC is $1,500 (1600e6 / 1.066…e9 * 1e9). RWA seeds stay at $5500. */
export const EVE_V4_DEFAULT_VIRTUAL_QUOTE = 1_600_000_000n

export const EVE_FEE_HOOK_SPLIT_COMPONENTS = [
  { name: 'feeBps', type: 'uint16' },
  { name: 'creatorBps', type: 'uint16' },
  { name: 'burnBps', type: 'uint16' },
  { name: 'holdersBps', type: 'uint16' },
  { name: 'autoLpBps', type: 'uint16' },
  { name: 'platformBps', type: 'uint16' },
] as const

export const EVE_INSTANT_V4_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'quote', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'launchVirtualQuote_', type: 'uint256' },
      { name: 'firstBuyQuoteAmount', type: 'uint256' },
      { name: 'split', type: 'tuple', components: EVE_FEE_HOOK_SPLIT_COMPONENTS },
      { name: 'holders', type: 'address' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'id', type: 'bytes32' },
      { name: 'tokensOut', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'hook',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'poolOf',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'quote', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'holders', type: 'address' },
      { name: 'id', type: 'bytes32' },
    ],
  },
  {
    type: 'event',
    name: 'TokenLaunched',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'quote', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: false },
      { name: 'tokenIsCurrency0', type: 'bool', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
    ],
  },
] as const

export const EVE_V4_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactIn',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export const EVE_V4_POOL_MANAGER_STATE_ABI = [
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const

/** EveFeeHook.configs(poolId) — feeBps is levied on swap output. */
export const EVE_FEE_HOOK_CONFIGS_ABI = [
  {
    type: 'function',
    name: 'configs',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'registered', type: 'bool' },
      { name: 'creator', type: 'address' },
      { name: 'holders', type: 'address' },
      { name: 'autoLp', type: 'address' },
      { name: 'platformWallet', type: 'address' },
      { name: 'launch', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'creatorBps', type: 'uint16' },
      { name: 'burnBps', type: 'uint16' },
      { name: 'holdersBps', type: 'uint16' },
      { name: 'autoLpBps', type: 'uint16' },
      { name: 'platformBps', type: 'uint16' },
    ],
  },
] as const

export type EveV4WriteCall = {
  address: Address
  abi: typeof EVE_INSTANT_V4_FACTORY_ABI
  functionName: 'createToken'
  args: unknown[]
  chainId: number
}

export function eveInstantV4Factory(): Address {
  if (!arcInstantV4Enabled()) throw new Error('v4 Instant factory not configured')
  return ARC.INSTANT_V4_FACTORY
}

export function splitToTuple(s: FeeSplit) {
  return {
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    burnBps: s.burnBps,
    holdersBps: s.holdersBps,
    autoLpBps: s.autoLpBps,
    platformBps: s.platformBps,
  }
}

export function buildCreateTokenEveV4(opts: {
  name: string
  symbol: string
  quote: Address
  creator: Address
  firstBuyQuoteRaw: bigint
  split: FeeSplit
  launchVirtualQuote?: bigint
  factory?: Address
}): EveV4WriteCall {
  const dest = opts.factory && opts.factory !== '0x0000000000000000000000000000000000000000'
    ? opts.factory
    : eveInstantV4Factory()
  const vq = opts.launchVirtualQuote ?? EVE_V4_DEFAULT_VIRTUAL_QUOTE
  return {
    address: dest,
    abi: EVE_INSTANT_V4_FACTORY_ABI,
    functionName: 'createToken',
    args: [
      opts.name,
      opts.symbol,
      opts.quote,
      opts.creator,
      vq,
      opts.firstBuyQuoteRaw,
      splitToTuple(opts.split),
      '0x0000000000000000000000000000000000000000',
    ],
    chainId: ARC_CHAIN_ID,
  }
}

export function parseV4PoolId(id: unknown): Hex | undefined {
  if (typeof id === 'string' && id.startsWith('0x') && id.length === 66) return id as Hex
  return undefined
}
