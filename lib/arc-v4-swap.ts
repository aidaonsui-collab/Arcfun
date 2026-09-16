/**
 * Exact-in swaps against eve.fun Instant v4 pools via EveV4Router.
 * Quote is a slot0 linear estimate with the hook fee haircut — not a full curve sim.
 */
import { concat, keccak256, pad, toHex, type Address, type Hex } from 'viem'
import { ARC, ARC_CHAIN_ID, instantV4CatalogFactories } from './contracts-arc'
import {
  EVE_FEE_HOOK_CONFIGS_ABI,
  EVE_INSTANT_V4_FACTORY_ABI,
  EVE_V4_POOL_MANAGER_STATE_ABI,
  EVE_V4_ROUTER_ABI,
  EVE_V4_TICK_SPACING,
} from './eve-instant-v4-launchpad'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
/** Uniswap v4 StateLibrary.POOLS_SLOT — pools mapping index on PoolManager. */
const POOLS_SLOT = pad(toHex(6n), { size: 32 })
const SQRT_PRICE_MASK = (1n << 160n) - 1n
const Q192 = 1n << 192n

/** EveFeeHook default Instant fee when configs() is unread. */
export const EVE_V4_DEFAULT_FEE_BPS = 100

export type EveV4PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type EveV4PoolInfo = {
  token: Address
  quote: Address
  creator: Address
  holders: Address
  poolId: Hex
  tokenIsCurrency0: boolean
  feeBps: number
  key: EveV4PoolKey
}

type Rpc = { readContract: (args: never) => Promise<unknown> }

export async function readEveV4Pool(
  token: Address,
  client: { readContract: (args: never) => Promise<unknown> },
): Promise<EveV4PoolInfo | null> {
  if (!ARC.INSTANT_V4_HOOK || ARC.INSTANT_V4_HOOK === ZERO) return null
  for (const factory of instantV4CatalogFactories()) {
    try {
      const row = (await client.readContract({
        address: factory,
        abi: EVE_INSTANT_V4_FACTORY_ABI,
        functionName: 'poolOf',
        args: [token],
      } as never)) as readonly [Address, Address, Address, Address, Hex]
      const launched = row[0]
      const quote = row[1]
      if (!launched || launched === ZERO || !quote || quote === ZERO) continue
      let hooks = ARC.INSTANT_V4_HOOK
      try {
        const factoryHook = (await client.readContract({
          address: factory,
          abi: EVE_INSTANT_V4_FACTORY_ABI,
          functionName: 'hook',
        } as never)) as Address
        if (factoryHook && factoryHook !== ZERO) hooks = factoryHook
      } catch {
        /* older factory ABI without hook(); PoolKey uses the env hook */
      }
      const tokenIsCurrency0 = launched.toLowerCase() < quote.toLowerCase()
      const currency0 = tokenIsCurrency0 ? launched : quote
      const currency1 = tokenIsCurrency0 ? quote : launched
      const poolId = row[4]
      const feeBps = await readEveV4FeeBps(hooks, poolId, client)
      return {
        token: launched,
        quote,
        creator: row[2],
        holders: row[3],
        poolId,
        tokenIsCurrency0,
        feeBps,
        key: {
          currency0,
          currency1,
          fee: 0,
          tickSpacing: EVE_V4_TICK_SPACING,
          hooks,
        },
      }
    } catch {
      /* try the next v4 factory */
    }
  }
  return null
}

/** `keccak256(abi.encodePacked(poolId, POOLS_SLOT))` — PoolManager.pools[id] */
export function eveV4PoolStateSlot(poolId: Hex): Hex {
  return keccak256(concat([poolId, POOLS_SLOT]))
}

export function sqrtPriceX96FromExtsload(word: Hex | bigint): bigint {
  const w = typeof word === 'bigint' ? word : BigInt(word)
  return w & SQRT_PRICE_MASK
}

/**
 * Exact-in amountOut at the current sqrt price, then EveFeeHook's output fee.
 * Instant ranges are wide; this is a quote for the pad, not a tick-walk.
 */
export function estimateEveV4ExactIn(opts: {
  amountIn: bigint
  zeroForOne: boolean
  sqrtPriceX96: bigint
  feeBps: number
}): bigint {
  if (opts.amountIn <= 0n || opts.sqrtPriceX96 <= 0n) return 0n
  const fee = Number.isFinite(opts.feeBps) ? Math.min(Math.max(0, Math.floor(opts.feeBps)), 10_000) : 0
  const sqrt2 = opts.sqrtPriceX96 * opts.sqrtPriceX96
  if (sqrt2 === 0n) return 0n
  const gross = opts.zeroForOne ? (opts.amountIn * sqrt2) / Q192 : (opts.amountIn * Q192) / sqrt2
  if (gross <= 0n) return 0n
  if (fee <= 0) return gross
  return (gross * BigInt(10_000 - fee)) / 10_000n
}

export async function readEveV4SqrtPriceX96(poolId: Hex, client: Rpc): Promise<bigint> {
  if (!ARC.POOL_MANAGER || ARC.POOL_MANAGER === ZERO) return 0n
  const word = (await client.readContract({
    address: ARC.POOL_MANAGER,
    abi: EVE_V4_POOL_MANAGER_STATE_ABI,
    functionName: 'extsload',
    args: [eveV4PoolStateSlot(poolId)],
  } as never)) as Hex
  return sqrtPriceX96FromExtsload(word)
}

export async function readEveV4FeeBps(hooks: Address, poolId: Hex, client: Rpc): Promise<number> {
  if (!hooks || hooks === ZERO) return EVE_V4_DEFAULT_FEE_BPS
  try {
    const row = (await client.readContract({
      address: hooks,
      abi: EVE_FEE_HOOK_CONFIGS_ABI,
      functionName: 'configs',
      args: [poolId],
    } as never)) as readonly [
      boolean,
      Address,
      Address,
      Address,
      Address,
      Address,
      number | bigint,
      number | bigint,
      number | bigint,
      number | bigint,
      number | bigint,
      number | bigint,
    ]
    const feeBps = Number(row[6])
    if (Number.isFinite(feeBps) && feeBps > 0) return feeBps
  } catch {
    /* older hook or RPC miss — Instant default is 1% */
  }
  return EVE_V4_DEFAULT_FEE_BPS
}

export async function quoteEveV4ExactIn(
  pool: EveV4PoolInfo,
  amountIn: bigint,
  zeroForOne: boolean,
  client: Rpc,
): Promise<bigint | null> {
  if (amountIn <= 0n) return null
  const sqrtPriceX96 = await readEveV4SqrtPriceX96(pool.poolId, client)
  if (sqrtPriceX96 <= 0n) return null
  const feeBps = pool.feeBps > 0 ? pool.feeBps : EVE_V4_DEFAULT_FEE_BPS
  const out = estimateEveV4ExactIn({ amountIn, zeroForOne, sqrtPriceX96, feeBps })
  return out > 0n ? out : null
}

export function buildEveV4Swap(opts: {
  key: EveV4PoolKey
  zeroForOne: boolean
  amountIn: bigint
  minOut: bigint
  recipient: Address
}) {
  if (!ARC.INSTANT_V4_ROUTER || ARC.INSTANT_V4_ROUTER === ZERO) {
    throw new Error('v4 swap router is not configured')
  }
  return {
    address: ARC.INSTANT_V4_ROUTER,
    abi: EVE_V4_ROUTER_ABI,
    functionName: 'swapExactIn' as const,
    args: [opts.key, opts.zeroForOne, opts.amountIn, opts.minOut, opts.recipient] as const,
    chainId: ARC_CHAIN_ID,
  }
}
