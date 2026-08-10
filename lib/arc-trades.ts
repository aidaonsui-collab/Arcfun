/**
 * Arc Instant trade tape — Uniswap V3 Swap events on TOKEN/USDC pools.
 * Arc RPCs often cap eth_getLogs to 10_000 blocks — scan newest→oldest in chunks.
 *
 * Persisted to Vercel KV (same arcfun: namespace as lib/arc-followers.ts / arc-token-meta.ts) so a
 * token's trade history survives forever once seen, instead of vanishing the moment its last trade
 * falls outside a live-scan lookback window. Before this, a token that went quiet for longer than
 * MAX_LOOKBACK (~14h) would show an empty chart/activity tape on every subsequent visit — the swaps
 * still happened, they'd just aged out of the window every fetch re-scanned from scratch. A 3rd-party
 * indexer (e.g. RadarDEX) never re-derives history from a bounded RPC window, so it never has this
 * problem — this makes ArcFun behave the same way: index once, keep forever, only ever scan the gap.
 */
import { kv } from '@vercel/kv'
import { erc20Abi as erc20DecimalsAbi, formatUnits, parseAbiItem, type Address, type Log } from 'viem'
import { ARC, arcPublicClient } from './contracts-arc'
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

const CHUNK = 9_000n
/**
 * How far back to seed a token's cursor the first time this store has ever seen it — ~3.5 days at
 * ~1s/block, 6x the old live-only scanner's ~14h window. This is only ever a *starting point*, not
 * a scan-in-one-shot size: cold start seeds the cursor here and then falls through to the exact
 * same bounded catch-up path warm tokens use (see CATCHUP_MAX_BLOCKS), so a deep backfill spreads
 * across however many requests it takes instead of risking one request scanning 300k blocks (~33
 * chunked eth_getLogs calls) and timing out. Once indexed, a token is never lost again regardless
 * of how long it goes quiet — this bound only limits how far back a token's *first-ever* index
 * reaches.
 */
const DEEP_BACKFILL_BLOCKS = 300_000n
/** Per-request cap on how far a scan (cold-start or warm catch-up) advances. Bounds a single
 *  request's duration regardless of how large the gap is — a token idle for months, or seen for
 *  the first time, just catches up over however many page loads it takes instead of one huge scan
 *  that risks a serverless timeout. */
const CATCHUP_MAX_BLOCKS = 200_000n
const MAX_TRADES = 50
/** How many trades to retain per token in KV. */
const TRADES_CAP = 400
const FRESH_MS = 6_000

const tradesKvKey = (token: string) => `arcfun:trades:${token.toLowerCase()}`
const cursorKvKey = (token: string) => `arcfun:trades:cursor:${token.toLowerCase()}`

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
async function resolvePool(
  token: Address,
): Promise<{ pool: Address; tokenIs0: boolean; tokenDecimals: number } | null> {
  try {
    const client = arcPublicClient()
    const t = await fetchArcPoolToken(token)
    const pool = t?.instantMeta?.uniPool as Address | undefined
    if (!pool || pool === ZERO) return null
    const [token0, tokenDecimals] = await Promise.all([
      client.readContract({ address: pool, abi: [T0], functionName: 'token0' }) as Promise<Address>,
      client
        .readContract({ address: token, abi: erc20DecimalsAbi, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
    ])
    return { pool, tokenIs0: token0.toLowerCase() === token.toLowerCase(), tokenDecimals }
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

/** Chunked ascending eth_getLogs scan over [fromBlock, toBlock], parsed into EvmTrade rows. Used
 *  for both the one-time cold-start backfill and the warm incremental catch-up — same shape,
 *  different range. */
async function scanSwapRange(
  client: ReturnType<typeof arcPublicClient>,
  pool: Address,
  tokenIs0: boolean,
  tokenDecimals: number,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<EvmTrade[]> {
  const out: EvmTrade[] = []
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const chunkEnd = cursor + CHUNK - 1n > toBlock ? toBlock : cursor + CHUNK - 1n
    let logs: V3SwapLog[] = []
    try {
      logs = (await client.getLogs({
        address: pool,
        event: V3_SWAP,
        fromBlock: cursor,
        toBlock: chunkEnd,
      })) as V3SwapLog[]
    } catch (e) {
      console.warn('[arc-trades] getLogs', summarizeRpcError(e))
      break
    }

    if (logs.length > 0) {
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

        const tokenHuman = Number(formatUnits(tokenAmt, tokenDecimals))
        const usdcHuman = Number(formatUnits(usdcAmt, 6))
        const price = tokenHuman > 0 ? usdcHuman / tokenHuman : 0
        const ts = tsMap.get((log.blockNumber ?? 0n).toString()) ?? 0
        const trader = (log.args.recipient as Address) || (log.args.sender as Address) || ZERO

        out.push({
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

    cursor = chunkEnd + 1n
  }
  return out
}

/**
 * Best-effort persist — a KV outage degrades to "scan fresh every request" (the old behaviour),
 * never a hard failure of the trades endpoint.
 *
 * Pass EvmTrade objects straight through, no manual JSON.stringify — @upstash/redis's default
 * serializer already JSON-encodes non-primitive command args on write and recursively JSON.parses
 * list results on read (see defaultSerializer / parseRecursive in @upstash/redis). Same convention
 * lib/arc-token-meta.ts and lib/arc-creator-meta.ts already rely on for kv.set/kv.get. Stringifying
 * here too would double-encode: reads would come back pre-parsed objects, a second JSON.parse on
 * those throws, and every persisted trade would silently vanish on the next request.
 */
async function persistTrades(key: string, ascendingNew: EvmTrade[], newCursor: bigint): Promise<void> {
  try {
    if (ascendingNew.length > 0) {
      await kv.rpush(tradesKvKey(key), ...ascendingNew)
      await kv.ltrim(tradesKvKey(key), -TRADES_CAP, -1)
    }
    await kv.set(cursorKvKey(key), newCursor.toString())
  } catch (e) {
    console.warn('[arc-trades] kv persist', summarizeRpcError(e))
  }
}

export async function fetchArcTrades(token: Address): Promise<EvmTradesResult> {
  const key = token.toLowerCase()
  const hit = mem.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.result

  try {
    const orient = await resolvePool(token)
    if (!orient) return empty
    const { pool, tokenIs0, tokenDecimals } = orient
    const client = arcPublicClient()
    const head = await client.getBlockNumber()

    let cursor: bigint | null = null
    try {
      const raw = await kv.get<string | number>(cursorKvKey(key))
      cursor = raw != null ? BigInt(raw) : null
    } catch (e) {
      console.warn('[arc-trades] kv read cursor', summarizeRpcError(e))
    }

    // First time this store has ever seen this token — seed the cursor DEEP_BACKFILL_BLOCKS back
    // and let the bounded catch-up below walk it forward, same as a warm token. Never scans the
    // whole backfill window in one request.
    if (cursor === null) {
      cursor = head >= DEEP_BACKFILL_BLOCKS ? head - DEEP_BACKFILL_BLOCKS : 0n
    }

    let foundThisCall: EvmTrade[] | null = null
    if (cursor < head) {
      const from = cursor + 1n
      const to = from + CATCHUP_MAX_BLOCKS - 1n > head ? head : from + CATCHUP_MAX_BLOCKS - 1n
      foundThisCall = await scanSwapRange(client, pool, tokenIs0, tokenDecimals, from, to)
      await persistTrades(key, foundThisCall, to)
    }
    // else: cursor >= head, already fully caught up — nothing to scan, read straight from KV.

    let ascending: EvmTrade[] | null = null
    try {
      // Already-deserialized objects, not JSON strings — see persistTrades' doc comment.
      ascending = await kv.lrange<EvmTrade>(tradesKvKey(key), -MAX_TRADES, -1)
    } catch (e) {
      console.warn('[arc-trades] kv read trades', summarizeRpcError(e))
    }
    // KV unavailable (or nothing stored yet) — fall back to whatever this request just scanned
    // live, so a KV outage degrades gracefully instead of returning nothing.
    if (ascending === null) ascending = (foundThisCall ?? []).slice(-MAX_TRADES)

    // Newest first, matching the API's existing contract
    const trimmed = [...ascending].reverse()

    // Price points oldest→newest for charts
    const pricePoints: PricePoint[] = ascending
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
