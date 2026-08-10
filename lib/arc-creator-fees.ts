/**
 * Creator LP fee positions — collect via MonLock.collectFees (permissionless; pays stamped wallets).
 */
import { type Address, type Abi } from 'viem'
import { ARC, arcPublicClient } from './contracts-arc'
import type { PoolToken } from './tokens'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

export const MONLOCK_COLLECT_ABI = [
  {
    type: 'function',
    name: 'collectFees',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'creatorSplits',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'wallet', type: 'address' },
      { name: 'bps', type: 'uint16' },
    ],
  },
] as const satisfies Abi

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

export type CreatorFeePosition = {
  token: Address
  symbol: string
  name: string
  positionId: string
  locker: Address
  creatorWallet: Address
  creatorBps: number
  tokensOwed0: string
  tokensOwed1: string
  token0: Address
  token1: Address
  hasOwed: boolean
}

function lockerForToken(t: PoolToken): Address {
  const factory = (t.moonbagsPackageId || '').toLowerCase()
  if (factory === ARC.REFLECTION_FACTORY.toLowerCase()) return ARC.REFLECTION_LOCKER
  return ARC.INSTANT_LOCKER
}

export async function listCreatorFeePositions(tokens: PoolToken[]): Promise<CreatorFeePosition[]> {
  const client = arcPublicClient()
  const nfpm = ARC.UNI_NFPM
  const out: CreatorFeePosition[] = []

  for (const t of tokens) {
    const pid = t.instantMeta?.positionId
    if (!pid || pid === '0') continue
    let positionId: bigint
    try {
      positionId = BigInt(pid)
    } catch {
      continue
    }
    if (positionId <= 0n) continue
    const locker = lockerForToken(t)
    if (!locker || locker === ZERO) continue
    const token = (t.coinType || t.poolId) as Address

    try {
      const [split, pos] = await Promise.all([
        client
          .readContract({
            address: locker,
            abi: MONLOCK_COLLECT_ABI,
            functionName: 'creatorSplits',
            args: [positionId],
          })
          .catch(() => null) as Promise<readonly [Address, number] | null>,
        client
          .readContract({
            address: nfpm,
            abi: NFPM_POSITIONS_ABI,
            functionName: 'positions',
            args: [positionId],
          })
          .catch(() => null) as Promise<readonly unknown[] | null>,
      ])

      if (!pos) continue
      const token0 = pos[2] as Address
      const token1 = pos[3] as Address
      const tokensOwed0 = pos[10] as bigint
      const tokensOwed1 = pos[11] as bigint
      const creatorWallet = (split?.[0] ?? ZERO) as Address
      const creatorBps = Number(split?.[1] ?? 0)

      out.push({
        token,
        symbol: t.symbol,
        name: t.name,
        positionId: positionId.toString(),
        locker,
        creatorWallet,
        creatorBps,
        tokensOwed0: tokensOwed0.toString(),
        tokensOwed1: tokensOwed1.toString(),
        token0,
        token1,
        hasOwed: tokensOwed0 > 0n || tokensOwed1 > 0n,
      })
    } catch {
      /* skip */
    }
  }
  return out
}
