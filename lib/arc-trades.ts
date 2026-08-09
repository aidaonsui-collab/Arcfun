/**
 * Arc Instant trade tape — Uniswap V3 Swap events on TOKEN/USDC pools.
 * Arc RPCs often cap eth_getLogs to 10_000 blocks — scan newest→oldest in chunks.
 */
import { formatUnits, parseAbiItem, type Address, type Log } from 'viem'
import { arcPublicClient } from './contracts-arc'
import { fetchArcPoolToken } from './arc-instant-tokens'
import {
  type EvmTrade,
  type EvmTradesResult,
  type EvmTradeStats,
  type PricePoint,
} from './evm-trades'
import { summarizeRpcError } from './rpc-error'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
type V3SwapLog = Log<bigint, number, false, typeof V3_SWAP, true>

const T0 = parseAbiItem('function token0() view returns (address)')
const T1 = parseAbiItem('function token1() view returns (address)')

/**
 * Radar-style recent tape: last ~50 swaps, no full history / no pagination.
 * Newest→oldest 9k chunks; stop once we have MAX_TRADES or hit lookback / empty streak.
 * Saves eth_getLogs range + response size vs scanning ~2d / 1_500 rows.
 */
const CHUNK = 9_000n
/** ~14h at ~1s/block — enough headroom for 50 swaps; quiet tokens stop via EMPTY_STOP. */
const MAX_LOOKBACK = 50_000n
const EMPTY_STOP = 4
const MAX_TRADES = 50
const FRESH_MS = 6_000

const empty: EvmTradesResult = {
  trades: [],
  stats: {
    txns: 0,
    buys: 0,
    sells: 0,
    volumeUsd: 0,
    buyVolUsd: 0,
    sellVolUsd: 0,
    traders: 0,
    buyers: 0,
    sellers: 0,
  },
  pricePoints: [],
}

const abs = (x: bigint) => (x < 0n ? -x : x)
const mem = new Map<string, { result: EvmTradesResult; at: number }>()

/**
 * Resolve the Uni V3 pool for any Arc pool type (Instant, Reflection, or graduated bonding-curve)
 * via the shared fetchArcPoolToken lookup instead of hardcoding the Instant factory — the old
 * Instant-only resolvePool silently returned "no trades" for Reflection/curve tokens even when
 * they had a live, tradeable pool.
 */
async function resolvePool(token: Address): Promise<{ pool: Address; tokenIs0: boolean } | null> {
  try {
    const client = arcPublicClient()
    const t = await fetchArcPoolToken(token)
    const pool = t?.instantMeta?.uniPool as Address | undefined
    if (!pool || pool === ZERO) return null
    const token0 = (await client.readContract({
      address: pool,
      abi: [T0],
      functionName: 'token0',
    })) as Address
    return { pool, tokenIs0: token0.toLowerCase() === token.toLowerCase() }
  } catch {
    return null
  }
}

function buildStats(trades: EvmTrade[]): EvmTradeStats {
  let buys = 0
  let sells = 0
  let volumeUsd = 0
  let buyVolUsd = 0
  let sellVolUsd = 0
  const traders = new Set<string>()
  const buyers = new Set<string>()
  const sellers = new Set<string>()
  for (const t of trades) {
    volumeUsd += t.valueUsd
    traders.add(t.trader.toLowerCase())
    if (t.isBuy) {
      buys++
      buyVolUsd += t.valueUsd
      buyers.add(t.trader.toLowerCase())
    } else {
      sells++
      sellVolUsd += t.valueUsd
      sellers.add(t.trader.toLowerCase())
    }
  }
  return {
    txns: trades.length,
    buys,
    sells,
    volumeUsd,
    buyVolUsd,
    sellVolUsd,
    traders: traders.size,
    buyers: buyers.size,
    sellers: sellers.size,
  }
}

export async function fetchArcTrades(token: Address): Promise<EvmTradesResult> {
  const key = token.toLowerCase()
  const hit = mem.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.result

  try {
    const orient = await resolvePool(token)
    if (!orient) return empty
    const { pool, tokenIs0 } = orient
    const client = arcPublicClient()
    const head = await client.getBlockNumber()

    const trades: EvmTrade[] = []
    let emptyChunks = 0
    let scanned = 0n
    let to = head

    while (scanned < MAX_LOOKBACK && trades.length < MAX_TRADES) {
      const from = to >= CHUNK - 1n ? to - (CHUNK - 1n) : 0n
      let logs: V3SwapLog[] = []
      try {
        logs = (await client.getLogs({
          address: pool,
          event: V3_SWAP,
          fromBlock: from,
          toBlock: to,
        })) as V3SwapLog[]
      } catch (e) {
        console.warn('[arc-trades] getLogs', summarizeRpcError(e))
        break
      }

      if (logs.length === 0) {
        emptyChunks++
        if (emptyChunks >= EMPTY_STOP && trades.length > 0) break
        if (emptyChunks >= EMPTY_STOP * 2 && trades.length === 0) break
      } else {
        emptyChunks = 0
        // Need block timestamps — batch unique blocks
        const blockNums = Array.from(new Set(logs.map((l) => l.blockNumber!)))
        const tsMap = new Map<string, number>()
        await Promise.all(
          blockNums.map(async (bn) => {
            try {
              const b = await client.getBlock({ blockNumber: bn })
              tsMap.set(bn.toString(), Number(b.timestamp))
            } catch {
              /* ignore */
            }
          }),
        )

        for (const log of logs) {
          const a0 = log.args.amount0 as bigint
          const a1 = log.args.amount1 as bigint
          // Token positive amount0/1 means pool received token → sell; negative → buy
          const tokenDelta = tokenIs0 ? a0 : a1
          const usdcDelta = tokenIs0 ? a1 : a0
          const isBuy = tokenDelta < 0n // user received token
          const tokenAmt = abs(tokenDelta)
          const usdcAmt = abs(usdcDelta)
          if (tokenAmt === 0n || usdcAmt === 0n) continue

          const tokenHuman = Number(formatUnits(tokenAmt, 6))
          const usdcHuman = Number(formatUnits(usdcAmt, 6))
          const price = tokenHuman > 0 ? usdcHuman / tokenHuman : 0
          const ts = tsMap.get((log.blockNumber ?? 0n).toString()) ?? 0
          const trader = (log.args.recipient as Address) || (log.args.sender as Address) || ZERO

          trades.push({
            txHash: log.transactionHash! as `0x${string}`,
            blockNumber: Number(log.blockNumber ?? 0n),
            ts,
            isBuy,
            trader,
            tokenAmount: tokenHuman,
            nativeAmount: usdcHuman,
            valueUsd: usdcHuman, // USDC ≈ $1
            price,
            priceUsd: price,
          })
        }
      }

      if (from === 0n) break
      scanned += to - from + 1n
      to = from - 1n
    }

    // Newest first
    trades.sort((a, b) => b.ts - a.ts || b.blockNumber - a.blockNumber)
    const trimmed = trades.slice(0, MAX_TRADES)

    // Price points oldest→newest for charts
    const chronological = [...trimmed].reverse()
    const pricePoints: PricePoint[] = chronological
      .filter((t) => t.ts > 0 && t.priceUsd > 0)
      .map((t) => ({ time: t.ts, value: t.priceUsd }))

    const result: EvmTradesResult = {
      trades: trimmed,
      stats: buildStats(trimmed),
      pricePoints,
    }
    mem.set(key, { result, at: Date.now() })
    return result
  } catch (e) {
    console.error('[arc-trades]', summarizeRpcError(e))
    return empty
  }
}
