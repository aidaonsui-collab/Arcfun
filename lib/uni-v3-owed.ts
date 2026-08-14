/**
 * Live Uniswap V3 position fees (tokensOwed + uncheckpointed feeGrowth).
 * Same wrapping uint256 math as Uniswap V3 core.
 */
import type { Address } from 'viem'

const Q128 = 1n << 128n
const U256 = (1n << 256n) - 1n

function wrapSub(a: bigint, b: bigint): bigint {
  return (a - b) & U256
}

const POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'feeGrowthGlobal0X128',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feeGrowthGlobal1X128',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ticks',
    stateMutability: 'view',
    inputs: [{ name: 'tick', type: 'int24' }],
    outputs: [
      { name: 'liquidityGross', type: 'uint128' },
      { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' },
      { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { name: 'tickCumulativeOutside', type: 'int56' },
      { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' },
      { name: 'secondsOutside', type: 'uint32' },
      { name: 'initialized', type: 'bool' },
    ],
  },
] as const

const NFPM_POSITIONS_ABI = [
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
] as const

function feeGrowthInside(
  global: bigint,
  outsideLower: bigint,
  outsideUpper: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const below = tickCurrent >= tickLower ? outsideLower : wrapSub(global, outsideLower)
  const above = tickCurrent < tickUpper ? outsideUpper : wrapSub(global, outsideUpper)
  return wrapSub(wrapSub(global, below), above)
}

function owedFromGrowth(tokensOwed: bigint, growthInside: bigint, growthLast: bigint, liquidity: bigint): bigint {
  if (liquidity === 0n) return tokensOwed
  return tokensOwed + (wrapSub(growthInside, growthLast) * liquidity) / Q128
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadClient = { readContract: (args: any) => Promise<any> }

export async function quoteFeesOwedOnPosition(opts: {
  client: ReadClient
  nfpm: Address
  pool: Address
  positionId: bigint
  quote: Address
}): Promise<bigint> {
  const { client, nfpm, pool, positionId, quote } = opts
  if (!pool || pool === '0x0000000000000000000000000000000000000000') return 0n
  if (positionId <= 0n) return 0n

  const [pos, slot0, g0, g1] = await Promise.all([
    client.readContract({
      address: nfpm,
      abi: NFPM_POSITIONS_ABI,
      functionName: 'positions',
      args: [positionId],
    }) as Promise<readonly unknown[]>,
    client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'slot0',
    }) as Promise<readonly unknown[]>,
    client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'feeGrowthGlobal0X128',
    }) as Promise<bigint>,
    client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'feeGrowthGlobal1X128',
    }) as Promise<bigint>,
  ])

  const token0 = (pos[2] as Address).toLowerCase()
  const token1 = (pos[3] as Address).toLowerCase()
  const tickLower = Number(pos[5])
  const tickUpper = Number(pos[6])
  const liquidity = pos[7] as bigint
  const growthLast0 = pos[8] as bigint
  const growthLast1 = pos[9] as bigint
  const owed0 = pos[10] as bigint
  const owed1 = pos[11] as bigint
  const tickCurrent = Number(slot0[1])

  const [lower, upper] = await Promise.all([
    client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'ticks',
      args: [tickLower],
    }) as Promise<readonly unknown[]>,
    client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'ticks',
      args: [tickUpper],
    }) as Promise<readonly unknown[]>,
  ])

  const inside0 = feeGrowthInside(g0, lower[2] as bigint, upper[2] as bigint, tickCurrent, tickLower, tickUpper)
  const inside1 = feeGrowthInside(g1, lower[3] as bigint, upper[3] as bigint, tickCurrent, tickLower, tickUpper)
  const total0 = owedFromGrowth(owed0, inside0, growthLast0, liquidity)
  const total1 = owedFromGrowth(owed1, inside1, growthLast1, liquidity)

  const q = quote.toLowerCase()
  if (token0 === q) return total0
  if (token1 === q) return total1
  return 0n
}
