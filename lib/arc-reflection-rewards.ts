/**
 * Holder reflection rewards (USDC / reward-token) across Instant Reflection launches.
 */
import { erc20Abi, formatUnits, type Address, type Abi } from 'viem'
import { ARC, arcPublicClient, arcReflectionEnabled } from './contracts-arc'
import { fetchArcReflectionPoolTokens } from './arc-instant-tokens'
import { isHiddenToken } from './tokens'
import { quoteFeesOwedOnPosition } from './uni-v3-owed'

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

const REFLECTION_FACTORY_VIEW_ABI = [
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
  {
    type: 'function',
    name: 'pendingReflectionQuote',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const TOKEN_SUPPLY_ABI = [
  {
    type: 'function',
    name: 'dividendBearingSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'excludedFromRewards',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const LOCKER_STAKER_ABI = [
  {
    type: 'function',
    name: 'stakerSplits',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'wallet', type: 'address' },
      { name: 'bps', type: 'uint16' },
    ],
  },
] as const

/** Factory default — 50% of quote-side LP fees go to holders. */
const DEFAULT_HOLDER_BPS = 5_000

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
  /** Holder share of uncollected LP + sink + factory pending (not yet reflected). */
  pendingHuman: number
  isUsdcReward: boolean
}

export type ReflectionRewardsSummary = {
  address: Address
  claimableUsdc: number
  /** Holder share of fees not yet reflected (next sweep). */
  pendingUsdc: number
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
 * Estimate this holder's USDC from the next keeper sweep:
 *   (pendingReflectionQuote + fee-sink USDC + uncollected quote LP × holder bps)
 *   × holding / dividendBearingSupply
 */
async function estimatePendingUsdcRaw(
  client: ReturnType<typeof arcPublicClient>,
  token: Address,
  wallet: Address,
  holdingRaw: bigint,
): Promise<bigint> {
  if (holdingRaw <= 0n) return 0n
  const factory = ARC.REFLECTION_FACTORY
  try {
    const [pool, pendingQuote, excluded, bearing] = await Promise.all([
      client.readContract({
        address: factory,
        abi: REFLECTION_FACTORY_VIEW_ABI,
        functionName: 'pools',
        args: [token],
      }) as Promise<readonly [Address, Address, Address, Address, bigint, bigint, number, number]>,
      client.readContract({
        address: factory,
        abi: REFLECTION_FACTORY_VIEW_ABI,
        functionName: 'pendingReflectionQuote',
        args: [token],
      }) as Promise<bigint>,
      client.readContract({
        address: token,
        abi: TOKEN_SUPPLY_ABI,
        functionName: 'excludedFromRewards',
        args: [wallet],
      }) as Promise<boolean>,
      client.readContract({
        address: token,
        abi: TOKEN_SUPPLY_ABI,
        functionName: 'dividendBearingSupply',
      }) as Promise<bigint>,
    ])
    if (excluded || bearing <= 0n) return 0n

    const [, , feeSink, uniPool, positionId] = pool
    const [sinkBal, staker] = await Promise.all([
      client.readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [feeSink],
      }) as Promise<bigint>,
      client
        .readContract({
          address: ARC.REFLECTION_LOCKER,
          abi: LOCKER_STAKER_ABI,
          functionName: 'stakerSplits',
          args: [positionId],
        })
        .catch(() => null) as Promise<readonly [Address, number] | null>,
    ])

    const holderBps = BigInt(staker?.[1] && staker[1] > 0 ? staker[1] : DEFAULT_HOLDER_BPS)
    let uncollectedQuote = 0n
    try {
      uncollectedQuote = await quoteFeesOwedOnPosition({
        client,
        nfpm: ARC.UNI_NFPM,
        pool: uniPool,
        positionId,
        quote: ARC.USDC,
      })
    } catch {
      uncollectedQuote = 0n
    }

    const holderLeg = (uncollectedQuote * holderBps) / 10_000n
    const pot = pendingQuote + sinkBal + holderLeg
    if (pot <= 0n) return 0n
    return (pot * holdingRaw) / bearing
  } catch {
    return 0n
  }
}

/**
 * Sum holder reflection rewards across catalog Instant Reflection tokens for `wallet`.
 */
export async function fetchReflectionRewards(wallet: Address): Promise<ReflectionRewardsSummary> {
  const empty: ReflectionRewardsSummary = {
    address: wallet,
    claimableUsdc: 0,
    pendingUsdc: 0,
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
  let pendingUsdc = 0
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

          const pendingRaw =
            holding > 0n
              ? await estimatePendingUsdcRaw(client, token, wallet, holding)
              : 0n
          const pendingHuman = toHuman(pendingRaw, 6)

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
            pendingHuman,
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
        pendingUsdc += row.pendingHuman
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
  lines.sort(
    (a, b) =>
      b.claimableHuman - a.claimableHuman ||
      b.pendingHuman - a.pendingHuman ||
      b.earnedHuman - a.earnedHuman,
  )

  return {
    address: wallet,
    claimableUsdc,
    pendingUsdc,
    earnedUsdc,
    claimedUsdc,
    otherClaimable: [...otherMap.entries()].map(([symbol, amount]) => ({ symbol, amount })),
    lines,
    tokensChecked: tokens.length,
    at: Date.now(),
  }
}
