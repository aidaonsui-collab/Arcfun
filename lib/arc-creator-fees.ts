/**
 * Creator LP fee positions — collect via MonLock.collectFees (permissionless; pays stamped wallets).
 *
 * Uniswap `tokensOwed` stays 0 until a collect checkpoints the NFT, so the profile used to look
 * empty even after the locker had already sent USDC to the rewards wallet. Pending uses live
 * feeGrowth. Collected sums USDC transfers from the locker to that wallet.
 */
import { parseAbiItem, type Address, type Abi } from 'viem'
import { ARC, arcPublicClient } from './contracts-arc'
import { quoteFeesOwedOnPosition } from './uni-v3-owed'
import { scanLogsChunked } from './arc-indexer/logs'
import type { PoolToken } from './tokens'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const USDC_DP = 6
const LOG_CHUNK = 9_000n
const COLLECT_MAX_CHUNKS = 12

const USDC_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

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
  uniPool: Address
  creatorWallet: Address
  creatorBps: number
  tokensOwed0: string
  tokensOwed1: string
  token0: Address
  token1: Address
  hasOwed: boolean
  /** Full uncollected quote USDC sitting in the LP NFT (not yet split). */
  pendingQuoteUsdc: number
  /** Creator bps of pendingQuoteUsdc. */
  pendingCreatorUsdc: number
  /** USDC already sent from this locker to the stamped rewards wallet. */
  collectedCreatorUsdc: number
  hasPending: boolean
}

function lockerForToken(t: PoolToken): Address {
  const factory = (t.moonbagsPackageId || '').toLowerCase()
  if (factory === ARC.REFLECTION_FACTORY.toLowerCase()) return ARC.REFLECTION_LOCKER
  return ARC.INSTANT_LOCKER
}

function usdc6(n: bigint): number {
  if (n <= 0n) return 0
  return Number(n) / 10 ** USDC_DP
}

function pairKey(locker: Address, wallet: Address): string {
  return `${locker.toLowerCase()}:${wallet.toLowerCase()}`
}

function fromBlockForTokens(tokens: PoolToken[], head: bigint): bigint {
  const now = Date.now() / 1000
  let oldest = now
  for (const t of tokens) {
    const ts = t.createdAt ?? 0
    const sec = ts > 1e12 ? ts / 1000 : ts
    if (sec > 0 && sec < oldest) oldest = sec
  }
  const ageSec = Math.max(0, now - oldest)
  // Arc blocks are ~1.5–2s. Over-scan so a 6h launch still fits in a few 9k windows.
  const est = BigInt(Math.ceil(ageSec / 1.4) + 4_000)
  const maxSpan = LOG_CHUNK * BigInt(COLLECT_MAX_CHUNKS)
  const span = est > maxSpan ? maxSpan : est
  return span >= head ? 0n : head - span
}

async function collectedUsdcByPair(
  client: ReturnType<typeof arcPublicClient>,
  pairs: { locker: Address; wallet: Address }[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const unique = new Map<string, { locker: Address; wallet: Address }>()
  for (const p of pairs) {
    if (!p.wallet || p.wallet === ZERO) continue
    unique.set(pairKey(p.locker, p.wallet), p)
  }
  await Promise.all(
    [...unique.values()].map(async ({ locker, wallet }) => {
      try {
        const { logs } = await scanLogsChunked(client, {
          address: ARC.USDC,
          event: USDC_TRANSFER,
          args: { from: locker, to: wallet },
          fromBlock,
          toBlock,
          maxChunks: COLLECT_MAX_CHUNKS,
        })
        let sum = 0n
        for (const log of logs) {
          const value = (log as { args?: { value?: bigint } }).args?.value
          if (typeof value === 'bigint' && value > 0n) sum += value
        }
        out.set(pairKey(locker, wallet), usdc6(sum))
      } catch {
        out.set(pairKey(locker, wallet), 0)
      }
    }),
  )
  return out
}

export async function listCreatorFeePositions(tokens: PoolToken[]): Promise<CreatorFeePosition[]> {
  const client = arcPublicClient()
  const nfpm = ARC.UNI_NFPM
  const usdc = ARC.USDC.toLowerCase()
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
    const uniPool = ((t.instantMeta?.uniPool || ZERO) as Address)

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
      const owedQuote =
        token0.toLowerCase() === usdc
          ? tokensOwed0
          : token1.toLowerCase() === usdc
            ? tokensOwed1
            : 0n

      out.push({
        token,
        symbol: t.symbol,
        name: t.name,
        positionId: positionId.toString(),
        locker,
        uniPool,
        creatorWallet,
        creatorBps,
        tokensOwed0: tokensOwed0.toString(),
        tokensOwed1: tokensOwed1.toString(),
        token0,
        token1,
        hasOwed: tokensOwed0 > 0n || tokensOwed1 > 0n,
        pendingQuoteUsdc: usdc6(owedQuote),
        pendingCreatorUsdc: creatorBps > 0 ? usdc6((owedQuote * BigInt(creatorBps)) / 10_000n) : usdc6(owedQuote),
        collectedCreatorUsdc: 0,
        hasPending: owedQuote > 0n,
      })
    } catch {
      /* skip */
    }
  }

  await Promise.all(
    out.map(async (row, i) => {
      const t = tokens.find(
        (tok) => (tok.coinType || tok.poolId || '').toLowerCase() === row.token.toLowerCase(),
      )
      const pool = (row.uniPool && row.uniPool !== ZERO ? row.uniPool : (t?.instantMeta?.uniPool as Address)) || ZERO
      if (!pool || pool === ZERO) return
      try {
        const owed = await quoteFeesOwedOnPosition({
          client,
          nfpm,
          pool,
          positionId: BigInt(row.positionId),
          quote: ARC.USDC,
        })
        const share =
          row.creatorBps > 0 ? (owed * BigInt(row.creatorBps)) / 10_000n : owed
        out[i] = {
          ...row,
          uniPool: pool,
          pendingQuoteUsdc: usdc6(owed),
          pendingCreatorUsdc: usdc6(share),
          hasPending: owed > 0n,
        }
      } catch {
        /* keep tokensOwed fallback */
      }
    }),
  )

  try {
    const head = await client.getBlockNumber()
    const fromBlock = fromBlockForTokens(tokens, head)
    const paid = await collectedUsdcByPair(
      client,
      out.map((r) => ({ locker: r.locker, wallet: r.creatorWallet })),
      fromBlock,
      head,
    )
    for (let i = 0; i < out.length; i++) {
      const n = paid.get(pairKey(out[i].locker, out[i].creatorWallet)) ?? 0
      out[i] = { ...out[i], collectedCreatorUsdc: n }
    }
  } catch {
    /* collected stays 0 */
  }

  return out
}
