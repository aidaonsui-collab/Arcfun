/**
 * Exact-in swaps against eve.fun Instant v4 pools via EveV4Router.
 * Quote is a slot0 linear estimate with the hook fee haircut — not a full curve sim.
 */
import { type Address, type Hex } from 'viem'
import { ARC, ARC_CHAIN_ID, instantV4CatalogFactories } from './contracts-arc'
import {
  EVE_INSTANT_V4_FACTORY_ABI,
  EVE_V4_ROUTER_ABI,
  EVE_V4_TICK_SPACING,
} from './eve-instant-v4-launchpad'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

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
  key: EveV4PoolKey
}

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
      return {
        token: launched,
        quote,
        creator: row[2],
        holders: row[3],
        poolId: row[4],
        tokenIsCurrency0,
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
