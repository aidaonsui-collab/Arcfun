import { erc20Abi, zeroAddress, type Address } from 'viem'
import {
  ARC,
  arcInstantEnabled,
  arcPublicClient,
  arcReflectionEnabled,
  instantCatalogFactories,
} from '@/lib/contracts-arc'
import { INSTANT_QUOTE_FACTORY_ABI } from '@/lib/instant-quote-launchpad'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { PORT_FACTORY_ABI } from './abi'
import { arcPortEnabled, arcPortFactory } from './contracts'

const REFLECTION_POOLS_ABI = [
  {
    type: 'function',
    name: 'pools',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
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
] as const

export type OriginTokenInfo = {
  token: Address
  name: string
  symbol: string
  creator: Address
  imageUrl?: string
  linkedCollection: Address | null
}

/** Instant / Reflection launch creator, or null if the token is not on the pad. */
export async function readPadCreator(token: Address): Promise<Address | null> {
  const client = arcPublicClient()
  if (arcInstantEnabled()) {
    for (const factory of instantCatalogFactories()) {
      try {
        const p = await client.readContract({
          address: factory,
          abi: INSTANT_QUOTE_FACTORY_ABI,
          functionName: 'getPool',
          args: [token],
        })
        if (p.creator && p.creator !== zeroAddress && p.uniPool && p.uniPool !== zeroAddress) {
          return p.creator
        }
      } catch {
        /* not this factory */
      }
    }
  }
  if (arcReflectionEnabled()) {
    try {
      const row = await client.readContract({
        address: ARC.REFLECTION_FACTORY,
        abi: REFLECTION_POOLS_ABI,
        functionName: 'pools',
        args: [token],
      })
      const c = row[0]
      const uniPool = row[3]
      if (c && c !== zeroAddress && uniPool && uniPool !== zeroAddress) return c
    } catch {
      /* not reflection */
    }
  }
  return null
}

export async function lookupOriginToken(raw: string): Promise<OriginTokenInfo | null> {
  if (!isPlausibleEvmAddress(raw)) return null
  const token = raw as Address
  const client = arcPublicClient()
  const creator = (await readPadCreator(token)) || zeroAddress

  if (creator === zeroAddress) return null

  let name = ''
  let symbol = ''
  try {
    ;[name, symbol] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    ])
  } catch {
    return null
  }

  const meta = await getArcTokenMeta(token).catch(() => null)
  let linkedCollection: Address | null = null
  if (arcPortEnabled()) {
    try {
      const linked = await client.readContract({
        address: arcPortFactory(),
        abi: PORT_FACTORY_ABI,
        functionName: 'collectionOfToken',
        args: [token],
      })
      if (linked && linked !== zeroAddress) linkedCollection = linked
    } catch {
      /* factory not live */
    }
  }

  return {
    token,
    name,
    symbol,
    creator,
    imageUrl: meta?.imageUrl,
    linkedCollection,
  }
}
