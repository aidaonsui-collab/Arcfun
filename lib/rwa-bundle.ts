/**
 * RWA Instant v4 holder basket — createTokenWithBundle + BundleSink.setBasket.
 * Holders never receive the raw quote MMF; convert() swaps into this basket first.
 */
import type { Address } from 'viem'
import { isAddress } from 'viem'
import type { FeeSplit } from './eve-fee-split'
import type { ArcRwaAsset } from './arc-rwa-assets'

const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042
const DEFAULT_VIRTUAL_QUOTE = 5_500_000_000n

const SPLIT_COMPONENTS = [
  { name: 'feeBps', type: 'uint16' },
  { name: 'creatorBps', type: 'uint16' },
  { name: 'burnBps', type: 'uint16' },
  { name: 'holdersBps', type: 'uint16' },
  { name: 'autoLpBps', type: 'uint16' },
  { name: 'platformBps', type: 'uint16' },
] as const

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address

/** Uniswap v4 hookless 0.3% pool — same defaults BundleSink tests seed. */
export const BUNDLE_DEFAULT_FEE = 3_000
export const BUNDLE_DEFAULT_TICK_SPACING = 60

export type BundlePayoutMode = 'all' | 'rotate'

export type BundlePoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type BasketRow = {
  id: string
  symbol: string
  address: string
  weightBps: number
  fee: number
  tickSpacing: number
  hooks: string
}

export const RWA_V4_FACTORY_ABI = [
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
      { name: 'split', type: 'tuple', components: SPLIT_COMPONENTS },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'id', type: 'bytes32' },
      { name: 'tokensOut', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'createTokenWithBundle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'quote', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'launchVirtualQuote_', type: 'uint256' },
      { name: 'firstBuyQuoteAmount', type: 'uint256' },
      { name: 'split', type: 'tuple', components: SPLIT_COMPONENTS },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'id', type: 'bytes32' },
      { name: 'tokensOut', type: 'uint256' },
      { name: 'bundleSink', type: 'address' },
    ],
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
] as const

export const BUNDLE_SINK_ABI = [
  {
    type: 'function',
    name: 'setBasket',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'address[]' },
      { name: 'weightsBps', type: 'uint16[]' },
      {
        name: 'poolKeys',
        type: 'tuple[]',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'mode_', type: 'uint8' },
    ],
    outputs: [],
  },
] as const

export function equalWeightsBps(n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(10_000 / n)
  const rem = 10_000 - base * n
  return Array.from({ length: n }, (_, i) => base + (i === n - 1 ? rem : 0))
}

export function sortPair(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
}

export function poolKeyForQuoteAsset(
  quote: Address,
  asset: Address,
  fee = BUNDLE_DEFAULT_FEE,
  tickSpacing = BUNDLE_DEFAULT_TICK_SPACING,
  hooks: Address = ZERO_ADDR,
): BundlePoolKey {
  const [currency0, currency1] = sortPair(quote, asset)
  return { currency0, currency1, fee, tickSpacing, hooks }
}

export function payoutModeToEnum(mode: BundlePayoutMode): number {
  return mode === 'rotate' ? 1 : 0
}

export function basketWeightSum(rows: BasketRow[]): number {
  return rows.reduce((n, r) => n + (Number.isFinite(r.weightBps) ? r.weightBps : 0), 0)
}

export function basketValid(
  rows: BasketRow[],
  opts: { quote: Address; mode: BundlePayoutMode },
): { ok: boolean; reason: string | null } {
  if (rows.length === 0) return { ok: false, reason: 'Add at least one basket asset.' }
  const seen = new Set<string>()
  const quote = opts.quote.toLowerCase()
  for (const row of rows) {
    if (!isAddress(row.address)) return { ok: false, reason: `${row.symbol || 'Asset'} needs a token address.` }
    const addr = row.address.toLowerCase()
    if (addr === quote) return { ok: false, reason: 'Basket cannot include the pair quote. Convert swaps out of it.' }
    if (seen.has(addr)) return { ok: false, reason: 'Each basket asset can only appear once.' }
    seen.add(addr)
    if (row.fee <= 0 || row.tickSpacing <= 0) {
      return { ok: false, reason: `${row.symbol || 'Asset'} needs a conversion pool fee and tick spacing.` }
    }
    if (row.hooks && row.hooks !== ZERO_ADDR && !isAddress(row.hooks)) {
      return { ok: false, reason: `${row.symbol || 'Asset'} hooks must be a 0x address.` }
    }
  }
  if (opts.mode === 'all') {
    const sum = basketWeightSum(rows)
    if (sum !== 10_000) {
      const rem = 10_000 - sum
      return {
        ok: false,
        reason: rem > 0 ? `Weights must sum to 100% (${(rem / 100).toFixed(0)}% left).` : `Weights are over 100%.`,
      }
    }
  }
  return { ok: true, reason: null }
}

export function encodeBasketArgs(rows: BasketRow[], quote: Address, mode: BundlePayoutMode) {
  const assets = rows.map((r) => r.address as Address)
  const weightsBps = rows.map((r) => r.weightBps)
  const poolKeys = rows.map((r) =>
    poolKeyForQuoteAsset(
      quote,
      r.address as Address,
      r.fee || BUNDLE_DEFAULT_FEE,
      r.tickSpacing || BUNDLE_DEFAULT_TICK_SPACING,
      (r.hooks && isAddress(r.hooks) ? r.hooks : ZERO_ADDR) as Address,
    ),
  )
  return {
    assets,
    weightsBps,
    poolKeys,
    mode: payoutModeToEnum(mode),
  }
}

export function buildCreateTokenRwaV4(opts: {
  factory: Address
  name: string
  symbol: string
  quote: Address
  creator: Address
  firstBuyQuoteRaw: bigint
  split: FeeSplit
  launchVirtualQuote?: bigint
}) {
  return {
    address: opts.factory,
    abi: RWA_V4_FACTORY_ABI,
    functionName: 'createToken' as const,
    args: [
      opts.name,
      opts.symbol,
      opts.quote,
      opts.creator,
      opts.launchVirtualQuote ?? DEFAULT_VIRTUAL_QUOTE,
      opts.firstBuyQuoteRaw,
      {
        feeBps: opts.split.feeBps,
        creatorBps: opts.split.creatorBps,
        burnBps: opts.split.burnBps,
        holdersBps: opts.split.holdersBps,
        autoLpBps: opts.split.autoLpBps,
        platformBps: opts.split.platformBps,
      },
    ] as const,
    chainId: ARC_CHAIN_ID,
  }
}

export function buildCreateTokenWithBundle(opts: {
  factory: Address
  name: string
  symbol: string
  quote: Address
  creator: Address
  firstBuyQuoteRaw: bigint
  split: FeeSplit
  launchVirtualQuote?: bigint
}) {
  return {
    address: opts.factory,
    abi: RWA_V4_FACTORY_ABI,
    functionName: 'createTokenWithBundle' as const,
    args: [
      opts.name,
      opts.symbol,
      opts.quote,
      opts.creator,
      opts.launchVirtualQuote ?? DEFAULT_VIRTUAL_QUOTE,
      opts.firstBuyQuoteRaw,
      {
        feeBps: opts.split.feeBps,
        creatorBps: opts.split.creatorBps,
        burnBps: opts.split.burnBps,
        holdersBps: opts.split.holdersBps,
        autoLpBps: opts.split.autoLpBps,
        platformBps: opts.split.platformBps,
      },
    ] as const,
    chainId: ARC_CHAIN_ID,
  }
}

export function buildSetBasket(opts: {
  sink: Address
  rows: BasketRow[]
  quote: Address
  mode: BundlePayoutMode
}) {
  const encoded = encodeBasketArgs(opts.rows, opts.quote, opts.mode)
  return {
    address: opts.sink,
    abi: BUNDLE_SINK_ABI,
    functionName: 'setBasket' as const,
    args: [encoded.assets, encoded.weightsBps, encoded.poolKeys, encoded.mode] as const,
    chainId: ARC_CHAIN_ID,
  }
}

export function catalogBasketOptions(all: ArcRwaAsset[], quoteId: string): ArcRwaAsset[] {
  return all.filter((a) => a.id !== quoteId)
}

/** Non-zero factory address. Caller should also exclude the live V3 Instant factory. */
export function rwaBundleFactoryReady(factory: string | null | undefined): boolean {
  const f = (factory || '').toLowerCase()
  return Boolean(f) && f !== ZERO_ADDR
}
