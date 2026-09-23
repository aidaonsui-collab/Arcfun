/**
 * Exact-in swaps against eve.fun Instant v4 pools via EveV4Router.
 * Quote is a slot0 linear estimate with the hook fee haircut — not a full curve sim.
 */
import {
  concat,
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbiParameters,
  toHex,
  type Address,
  type Client,
  type Hex,
} from 'viem'
import { call, readContract } from 'viem/actions'
import { ARC, ARC_CHAIN_ID, instantV4CatalogFactories } from './contracts-arc'
import {
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
  /** Buy fee. Equal to sellFeeBps on hooks that still store one fee. */
  feeBps: number
  buyFeeBps: number
  sellFeeBps: number
  key: EveV4PoolKey
}

export async function readEveV4Pool(
  token: Address,
  client: Client,
): Promise<EveV4PoolInfo | null> {
  if (!ARC.INSTANT_V4_HOOK || ARC.INSTANT_V4_HOOK === ZERO) return null
  for (const factory of instantV4CatalogFactories()) {
    try {
      const row = (await readContract(client, {
        address: factory,
        abi: EVE_INSTANT_V4_FACTORY_ABI,
        functionName: 'poolOf',
        args: [token],
      })) as readonly [Address, Address, Address, Address, Hex]
      const launched = row[0]
      const quote = row[1]
      if (!launched || launched === ZERO || !quote || quote === ZERO) continue
      let hooks = ARC.INSTANT_V4_HOOK
      try {
        const factoryHook = (await readContract(client, {
          address: factory,
          abi: EVE_INSTANT_V4_FACTORY_ABI,
          functionName: 'hook',
        })) as Address
        if (factoryHook && factoryHook !== ZERO) hooks = factoryHook
      } catch {
        /* older factory ABI without hook(); PoolKey uses the env hook */
      }
      const tokenIsCurrency0 = launched.toLowerCase() < quote.toLowerCase()
      const currency0 = tokenIsCurrency0 ? launched : quote
      const currency1 = tokenIsCurrency0 ? quote : launched
      const poolId = row[4]
      const fees = await readEveV4Fees(hooks, poolId, client)
      return {
        token: launched,
        quote,
        creator: row[2],
        holders: row[3],
        poolId,
        tokenIsCurrency0,
        feeBps: fees.buyFeeBps,
        buyFeeBps: fees.buyFeeBps,
        sellFeeBps: fees.sellFeeBps,
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

export async function readEveV4SqrtPriceX96(poolId: Hex, client: Client): Promise<bigint> {
  if (!ARC.POOL_MANAGER || ARC.POOL_MANAGER === ZERO) return 0n
  const word = (await readContract(client, {
    address: ARC.POOL_MANAGER,
    abi: EVE_V4_POOL_MANAGER_STATE_ABI,
    functionName: 'extsload',
    args: [eveV4PoolStateSlot(poolId)],
  })) as Hex
  return sqrtPriceX96FromExtsload(word)
}

const CONFIGS_CALL_ABI = [
  {
    type: 'function',
    name: 'configs',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
] as const

const CONFIGS_OLD = parseAbiParameters(
  'bool, address, address, address, address, address, uint16, uint16, uint16, uint16, uint16, uint16',
)
const CONFIGS_DUAL = parseAbiParameters(
  'bool, address, address, address, address, address, uint16, uint16, uint16, uint16, uint16, uint16, uint16',
)

function feeOrDefault(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : EVE_V4_DEFAULT_FEE_BPS
}

/** Old hooks return 12 words (one feeBps). New hooks return 13 (buy, then sell). */
export async function readEveV4Fees(
  hooks: Address,
  poolId: Hex,
  client: Client,
): Promise<{ buyFeeBps: number; sellFeeBps: number }> {
  const fallback = { buyFeeBps: EVE_V4_DEFAULT_FEE_BPS, sellFeeBps: EVE_V4_DEFAULT_FEE_BPS }
  if (!hooks || hooks === ZERO) return fallback
  try {
    const data = encodeFunctionData({ abi: CONFIGS_CALL_ABI, functionName: 'configs', args: [poolId] })
    const res = await call(client, { to: hooks, data })
    const raw = res.data
    if (!raw || raw === '0x') return fallback
    const words = (raw.length - 2) / 64
    if (words >= 13) {
      const row = decodeAbiParameters(CONFIGS_DUAL, raw)
      return { buyFeeBps: feeOrDefault(row[6]), sellFeeBps: feeOrDefault(row[7]) }
    }
    if (words >= 12) {
      const row = decodeAbiParameters(CONFIGS_OLD, raw)
      const fee = feeOrDefault(row[6])
      return { buyFeeBps: fee, sellFeeBps: fee }
    }
  } catch {
    /* older hook or RPC miss — Instant default is 1% */
  }
  return fallback
}

export async function readEveV4FeeBps(hooks: Address, poolId: Hex, client: Client): Promise<number> {
  return (await readEveV4Fees(hooks, poolId, client)).buyFeeBps
}

export async function quoteEveV4ExactIn(
  pool: EveV4PoolInfo,
  amountIn: bigint,
  zeroForOne: boolean,
  client: Client,
): Promise<bigint | null> {
  if (amountIn <= 0n) return null
  const sqrtPriceX96 = await readEveV4SqrtPriceX96(pool.poolId, client)
  if (sqrtPriceX96 <= 0n) return null
  const buying = zeroForOne !== pool.tokenIsCurrency0
  const sideFee = buying ? pool.buyFeeBps : pool.sellFeeBps
  const feeBps = sideFee > 0 ? sideFee : pool.feeBps > 0 ? pool.feeBps : EVE_V4_DEFAULT_FEE_BPS
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
