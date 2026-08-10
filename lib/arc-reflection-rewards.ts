/**
 * Holder reflection rewards (USDC / reward-token) across Instant Reflection launches.
 */
import { formatUnits, type Address, type Abi } from 'viem'
import { ARC, arcPublicClient, arcReflectionEnabled } from './contracts-arc'
import { fetchArcReflectionPoolTokens } from './arc-instant-tokens'
import { isHiddenToken } from './tokens'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

export const REFLECTION_REWARD_ABI = [
  {
    type: 'function',
    name: 'withdrawableRewardOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'accumulativeRewardOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawnRewards',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'rewardToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const satisfies Abi

const ERC20_META_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const

export type ReflectionRewardLine = {
  token: Address
  name: string
  symbol: string
  /** Holder balance of the meme token (human) */
  holdingHuman: number
  rewardToken: Address
  rewardSymbol: string
  rewardDecimals: number
  /** Claimable now (raw) */
  claimableRaw: string
  claimableHuman: number
  /** Lifetime earned including claimed (raw) */
  earnedRaw: string
  earnedHuman: number
  /** Already claimed / pushed (raw) */
  claimedRaw: string
  claimedHuman: number
  isUsdcReward: boolean
}

export type ReflectionRewardsSummary = {
  address: Address
  claimableUsdc: number
  earnedUsdc: number
  claimedUsdc: number
  /** Non-USDC claimable, labeled by symbol (rare) */
  otherClaimable: { symbol: string; amount: number }[]
  lines: ReflectionRewardLine[]
  tokensChecked: number
  at: number
}

function toHuman(raw: bigint, decimals: number): number {
  try {
    const n = Number(formatUnits(raw, decimals))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * Sum holder reflection rewards across catalog Instant Reflection tokens for `wallet`.
 */
export async function fetchReflectionRewards(wallet: Address): Promise<ReflectionRewardsSummary> {
  const empty: ReflectionRewardsSummary = {
    address: wallet,
    claimableUsdc: 0,
    earnedUsdc: 0,
    claimedUsdc: 0,
    otherClaimable: [],
    lines: [],
    tokensChecked: 0,
    at: Date.now(),
  }
  if (!arcReflectionEnabled()) return empty

  const client = arcPublicClient()
  const catalog = await fetchArcReflectionPoolTokens().catch(() => [])
  const tokens = catalog
    .map((t) => (t.coinType || t.poolId) as Address)
    .filter((a) => a && a !== ZERO && !isHiddenToken(a))

  const lines: ReflectionRewardLine[] = []
  let claimableUsdc = 0
  let earnedUsdc = 0
  let claimedUsdc = 0
  const otherMap = new Map<string, number>()

  // Sequential batches of 8 to avoid RPC burst kills
  for (let i = 0; i < tokens.length; i += 8) {
    const batch = tokens.slice(i, i + 8)
    const rows = await Promise.all(
      batch.map(async (token) => {
        try {
          const [claimable, earned, claimed, rewardToken, holding, name, symbol] = await Promise.all([
            client.readContract({
              address: token,
              abi: REFLECTION_REWARD_ABI,
              functionName: 'withdrawableRewardOf',
              args: [wallet],
            }) as Promise<bigint>,
            client.readContract({
              address: token,
              abi: REFLECTION_REWARD_ABI,
              functionName: 'accumulativeRewardOf',
              args: [wallet],
            }) as Promise<bigint>,
            client.readContract({
              address: token,
              abi: REFLECTION_REWARD_ABI,
              functionName: 'withdrawnRewards',
              args: [wallet],
            }) as Promise<bigint>,
            client.readContract({
              address: token,
              abi: REFLECTION_REWARD_ABI,
              functionName: 'rewardToken',
            }) as Promise<Address>,
            client.readContract({
              address: token,
              abi: REFLECTION_REWARD_ABI,
              functionName: 'balanceOf',
              args: [wallet],
            }) as Promise<bigint>,
            client
              .readContract({ address: token, abi: REFLECTION_REWARD_ABI, functionName: 'name' })
              .catch(() => '') as Promise<string>,
            client
              .readContract({ address: token, abi: REFLECTION_REWARD_ABI, functionName: 'symbol' })
              .catch(() => '') as Promise<string>,
          ])

          // Skip dust-empty positions with no history
          if (claimable === 0n && earned === 0n && claimed === 0n && holding === 0n) return null

          const [rewardDecimals, rewardSymbol] = await Promise.all([
            client
              .readContract({
                address: rewardToken,
                abi: ERC20_META_ABI,
                functionName: 'decimals',
              })
              .then((d) => Number(d))
              .catch(() => 6) as Promise<number>,
            client
              .readContract({
                address: rewardToken,
                abi: ERC20_META_ABI,
                functionName: 'symbol',
              })
              .catch(() => 'USDC') as Promise<string>,
          ])

          const dec = Number.isFinite(rewardDecimals) && rewardDecimals > 0 ? rewardDecimals : 6
          // Reflection launch tokens are 6dp
          const holdingHuman = toHuman(holding, 6)
          const claimableHuman = toHuman(claimable, dec)
          const earnedHuman = toHuman(earned, dec)
          const claimedHuman = toHuman(claimed, dec)
          const isUsdcReward =
            rewardToken.toLowerCase() === ARC.USDC.toLowerCase() ||
            rewardSymbol.toUpperCase() === 'USDC'

          return {
            token,
            name: name || symbol || 'Token',
            symbol: symbol || '???',
            holdingHuman,
            rewardToken,
            rewardSymbol: rewardSymbol || 'USDC',
            rewardDecimals: dec,
            claimableRaw: claimable.toString(),
            claimableHuman,
            earnedRaw: earned.toString(),
            earnedHuman,
            claimedRaw: claimed.toString(),
            claimedHuman,
            isUsdcReward,
          } satisfies ReflectionRewardLine
        } catch {
          return null
        }
      }),
    )

    for (const row of rows) {
      if (!row) continue
      lines.push(row)
      if (row.isUsdcReward) {
        claimableUsdc += row.claimableHuman
        earnedUsdc += row.earnedHuman
        claimedUsdc += row.claimedHuman
      } else if (row.claimableHuman > 0) {
        otherMap.set(
          row.rewardSymbol,
          (otherMap.get(row.rewardSymbol) || 0) + row.claimableHuman,
        )
      }
    }
  }

  // Largest claimable first
  lines.sort((a, b) => b.claimableHuman - a.claimableHuman || b.earnedHuman - a.earnedHuman)

  return {
    address: wallet,
    claimableUsdc,
    earnedUsdc,
    claimedUsdc,
    otherClaimable: [...otherMap.entries()].map(([symbol, amount]) => ({ symbol, amount })),
    lines,
    tokensChecked: tokens.length,
    at: Date.now(),
  }
}
