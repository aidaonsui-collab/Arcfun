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
import { after } from 'next/server'
import { kv } from '@vercel/kv'
import { createPublicClient, erc20Abi, formatUnits, http, parseAbiItem, type Address, type Log } from 'viem'
import {
  ARC,
  arcChain,
  arcLogsClient,
  arcLogsRpcUrls,
  arcPublicClient,
  isArcRpcInfraError,
} from './contracts-arc'
import { fetchArcPoolToken } from './arc-instant-tokens'
import { getToken } from './arc-indexer/store'
import { coalesceAsync } from './coalesce'
import {
  type EvmTrade,
  type EvmTradesResult,
  type EvmTradeStats,
  type PricePoint,
} from './evm-trades'
import { summarizeRpcError } from './rpc-error'
import { staleTapeRewindFrom, shouldPersistScanCursor, tapeIsStaleTs } from './arc-trades-cursor'
import { quoteDecimalsForToken, quoteTokenForFactory } from './arc-rwa-assets'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

const tokenDecimalsCache = new Map<string, number>()

async function tokenDecimalsOf(token: Address): Promise<number> {
  const k = token.toLowerCase()
  const hit = tokenDecimalsCache.get(k)
  if (hit) return hit
  try {
    const d = Number(
      await arcPublicClient().readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    )
    const n = Number.isFinite(d) && d > 0 && d <= 18 ? d : ARC.TOKEN_DECIMALS
    tokenDecimalsCache.set(k, n)
    return n
  } catch {
    return ARC.TOKEN_DECIMALS
  }
}

const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
type V3SwapLog = Log<bigint, number, false, typeof V3_SWAP, true>

const CHUNK = 9_000n
/**
 * How far back a token's FIRST-EVER scan reaches — ~3.5 days at ~1s/block, 6x the old live-only
 * scanner's ~14h window. Scanned in full, all the way to `head`, in that one cold-start request
 * (not bounded by CATCHUP_MAX_BLOCKS below) — see the isColdStart branch in fetchArcTrades for why
 * a bounded first scan silently missed a brand-new token's most recent trades. Once indexed, a
 * token is never lost again regardless of how long it goes quiet afterward — this bound only
 * limits how far back a token's *first-ever* index reaches.
 */
const DEEP_BACKFILL_BLOCKS = 300_000n
/** Per-request cap on how far a WARM (already-indexed) token's catch-up scan advances. Bounds a
 *  single request's duration if a token's been idle a long time since its last visit — it just
 *  catches up over however many page loads it takes instead of one huge scan that risks a
 *  serverless timeout. Does not apply to the one-time cold-start scan (see DEEP_BACKFILL_BLOCKS). */
const CATCHUP_MAX_BLOCKS = 200_000n
const MAX_TRADES = 50
/** How many trades to retain per token in KV. */
const TRADES_CAP = 400
const FRESH_MS = 6_000

const tradesKvKey = (token: string) => `arcfun:trades:${token.toLowerCase()}`
const cursorKvKey = (token: string) => `arcfun:trades:cursor:${token.toLowerCase()}`
const seenKvKey = (token: string) => `arcfun:trades:seen:${token.toLowerCase()}`

function tradeId(t: Pick<EvmTrade, 'txHash' | 'logIndex'>): string {
  return t.logIndex != null ? `${t.txHash}:${t.logIndex}` : t.txHash
}

function dedupeTrades(trades: EvmTrade[]): EvmTrade[] {
  const seen = new Set<string>()
  const out: EvmTrade[] = []
  for (const t of trades) {
    const id = tradeId(t)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(t)
  }
  return out
}

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
 * How recently a token's cursor must have been synced to head to skip re-checking. Separate from
 * FRESH_MS (which is keyed per page/limit/offset): this covers every page for a token with one
 * timer, so a busy token doesn't pay getBlockNumber + a KV cursor read on every distinct
 * limit/offset combination within the same few seconds.
 */
const SYNC_FRESH_MS = 6_000
const lastSyncedAt = new Map<string, number>()

/**
 * Resolve the Uni V3 pool for any Arc pool type (Instant, Reflection, or graduated bonding-curve)
 * via the shared fetchArcPoolToken lookup instead of hardcoding the Instant factory — the old
 * Instant-only resolvePool silently returned "no trades" for Reflection/curve tokens even when
 * they had a live, tradeable pool.
 */
async function resolvePool(
  token: Address,
): Promise<{ pool: Address; tokenIs0: boolean; tokenDecimals: number; quoteDecimals: number } | null> {
  try {
    let pool: Address | undefined
    let factory = ''
    // KV first — no eth_call. Infura quota on getPool/token0 used to make
    // resolvePool return null and skip the whole tape sync.
    try {
      const row = await getToken(token)
      if (row?.pool && row.pool !== ZERO) pool = row.pool as Address
      factory = row?.factory || ''
    } catch {
      /* fall through to on-chain */
    }
    if (!pool) {
      const t = await fetchArcPoolToken(token)
      pool = t?.instantMeta?.uniPool as Address | undefined
      factory = t?.moonbagsPackageId || factory
    }
    if (!pool || pool === ZERO) return null
    const quote = (quoteTokenForFactory(factory) || ARC.USDC_ERC20 || ARC.USDC).toLowerCase()
    const tokenIs0 = token.toLowerCase() < quote
    return {
      pool,
      tokenIs0,
      tokenDecimals: await tokenDecimalsOf(token),
      quoteDecimals: quoteDecimalsForToken(quote),
    }
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
async function getSwapLogs(pool: Address, fromBlock: bigint, toBlock: bigint): Promise<V3SwapLog[]> {
  const urls = arcLogsRpcUrls()
  let lastEmpty: V3SwapLog[] = []
  // Tracks whether ANY url gave a definitive answer (even an empty one) — separate from
  // lastErr, which used to survive past a later success and get thrown anyway.
  let gotSuccess = false
  let lastErr: unknown
  for (let i = 0; i < urls.length; i++) {
    const client = createPublicClient({
      chain: arcChain,
      transport: http(urls[i], { retryCount: 0, timeout: 4_000 }),
    })
    try {
      const logs = (await client.getLogs({
        address: pool,
        event: V3_SWAP,
        fromBlock,
        toBlock,
      })) as V3SwapLog[]
      if (logs.length > 0) return logs
      lastEmpty = logs
      gotSuccess = true
      // Empty is not final when another URL might still have the fills — try the rest, but
      // this IS a real, trustworthy answer if nothing better turns up.
      continue
    } catch (e) {
      lastErr = e
      if (!isArcRpcInfraError(e) && i === urls.length - 1) throw e
    }
  }
  // Root cause of EVE's trade tape freezing for ~2.8h (2026-09-04): this used to be
  // `if (lastEmpty.length === 0 && lastErr) throw lastErr` — throwing lastErr whenever the
  // final tally was empty, with no regard for WHEN that error happened relative to a real
  // success. The gap's first 9k-block chunk legitimately has zero swaps; baracat was failing
  // on nearly every attempt; arc-scan correctly answered "0 logs" for that same chunk — a
  // real, trustworthy empty result — but the stale baracat error from earlier in the SAME
  // loop got thrown instead, discarding it. scanSwapRange treats any throw from here as
  // "chunk failed, stop, do not advance" (deliberately, to never skip a gap — a real prior
  // EVE bug), so this one wrong throw silently refused to ever get past that first chunk,
  // no matter how many times it was retried, for as long as baracat stayed down.
  //
  // A url that answered — even empty — is a real answer. Only throw when EVERY url failed
  // outright and none ever produced one.
  if (gotSuccess) return lastEmpty
  throw lastErr
}

async function scanSwapRange(
  client: ReturnType<typeof arcLogsClient>,
  pool: Address,
  tokenIs0: boolean,
  tokenDecimals: number,
  fromBlock: bigint,
  toBlock: bigint,
  quoteDecimals = 6,
): Promise<{ trades: EvmTrade[]; scannedTo: bigint }> {
  const out: EvmTrade[] = []
  let cursor = fromBlock
  let scannedTo = fromBlock > 0n ? fromBlock - 1n : 0n
  while (cursor <= toBlock) {
    const chunkEnd = cursor + CHUNK - 1n > toBlock ? toBlock : cursor + CHUNK - 1n
    let logs: V3SwapLog[] = []
    try {
      logs = await getSwapLogs(pool, cursor, chunkEnd)
    } catch (e) {
      console.warn('[arc-trades] getLogs', summarizeRpcError(e))
      // Do not advance past a failed chunk — persisting `to` used to skip the gap
      // and freeze the tape (EVE 2026-09-01).
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
        const usdcHuman = Number(formatUnits(usdcAmt, quoteDecimals))
        const price = tokenHuman > 0 ? usdcHuman / tokenHuman : 0
        const ts = tsMap.get((log.blockNumber ?? 0n).toString()) ?? 0
        const trader = (log.args.recipient as Address) || (log.args.sender as Address) || ZERO

        out.push({
          txHash: log.transactionHash! as `0x${string}`,
          logIndex: Number(log.logIndex ?? 0),
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

    scannedTo = chunkEnd
    cursor = chunkEnd + 1n
  }
  return { trades: out, scannedTo }
}

/** USD swapped in [fromBlock, toBlock] (USDC ≈ $1). Used for lifetime pad volume. */
export async function sumSwapUsd(
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<number> {
  if (fromBlock > toBlock) return 0
  const orient = await resolvePool(token)
  if (!orient) return 0
  const client = arcLogsClient()
  const { trades } = await scanSwapRange(
    client,
    orient.pool,
    orient.tokenIs0,
    orient.tokenDecimals,
    fromBlock,
    toBlock,
    orient.quoteDecimals,
  )
  let usd = 0
  for (const t of trades) usd += t.valueUsd || 0
  return usd
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
    const fresh: EvmTrade[] = []
    for (const t of ascendingNew) {
      const id = tradeId(t)
      try {
        const added = Number(await kv.sadd(seenKvKey(key), id))
        if (added > 0) fresh.push(t)
      } catch {
        fresh.push(t)
      }
    }
    if (fresh.length > 0) {
      await kv.rpush(tradesKvKey(key), ...fresh)
      await kv.ltrim(tradesKvKey(key), -TRADES_CAP, -1)
    }
    await kv.set(cursorKvKey(key), newCursor.toString())
  } catch (e) {
    console.warn('[arc-trades] kv persist', summarizeRpcError(e))
  }
}

/**
 * Catch a token's persisted trade history up to the current chain head: resolve its pool,
 * read the KV cursor, and scan whatever gap remains (full DEEP_BACKFILL_BLOCKS on a cold token,
 * a CATCHUP_MAX_BLOCKS-bounded gap on a warm one). Writes the new cursor via persistTrades.
 *
 * Coalesced by token (not by page/limit/offset) via coalesceAsync, and skipped entirely within
 * SYNC_FRESH_MS of the last sync. Both matter together: a single token page fires three requests
 * that all end up here (trades×2 at different limits, plus ohlcv's own fetchArcTrades call) —
 * without this they each independently paid for resolvePool + getBlockNumber + a KV cursor read,
 * and on a cold or stale-cursor token, an eth_getLogs catch-up scan too, racing each other to
 * write the same cursor. Measured live before this fix: one page view, ~5s per request, four
 * times over. Now the first caller pays it once and the rest await that same call.
 */
const lastRewindAt = new Map<string, number>()

/** Repair a cursor that jumped over a failed/empty getLogs gap. */
async function maybeRewindStaleCursor(
  client: ReturnType<typeof arcLogsClient>,
  key: string,
  pool: Address,
  tokenIs0: boolean,
  tokenDecimals: number,
  head: bigint,
  quoteDecimals = 6,
): Promise<void> {
  const prev = lastRewindAt.get(key)
  if (prev != null && Date.now() - prev < 60_000) return
  let last: EvmTrade | undefined
  try {
    const rows = (await kv.lrange<EvmTrade>(tradesKvKey(key), -1, -1)) ?? []
    last = rows[0]
  } catch {
    return
  }
  const now = Math.floor(Date.now() / 1000)
  const from = staleTapeRewindFrom({
    head,
    lastTradeBlock: last?.blockNumber || 0,
    lastTradeTs: last?.ts || 0,
    nowSec: now,
  })
  if (from == null) return
  lastRewindAt.set(key, Date.now())
  const found = await scanSwapRange(client, pool, tokenIs0, tokenDecimals, from, head, quoteDecimals)
  if (
    shouldPersistScanCursor({
      foundTrades: found.trades.length,
      scannedTo: found.scannedTo,
      from,
      tapeIsStale: tapeIsStaleTs(last?.ts || 0, now),
    })
  ) {
    await persistTrades(key, found.trades, found.scannedTo)
  }
}

export async function syncTradesToHead(token: Address): Promise<void> {
  const key = token.toLowerCase()
  const last = lastSyncedAt.get(key)
  if (last != null && Date.now() - last < SYNC_FRESH_MS) return

  let didWork = false
  await coalesceAsync(`sync:${key}`, async () => {
    const orient = await resolvePool(token)
    if (!orient) return
    didWork = true
    const { pool, tokenIs0, tokenDecimals, quoteDecimals } = orient
    const client = arcLogsClient()
    const head = await client.getBlockNumber()

    let cursor: bigint | null = null
    try {
      const raw = await kv.get<string | number>(cursorKvKey(key))
      cursor = raw != null ? BigInt(raw) : null
    } catch (e) {
      console.warn('[arc-trades] kv read cursor', summarizeRpcError(e))
    }

    const isColdStart = cursor === null

    let newestTs = 0
    try {
      const tail = (await kv.lrange<EvmTrade>(tradesKvKey(key), -1, -1)) ?? []
      newestTs = tail[0]?.ts || 0
    } catch {
      /* rewind still runs */
    }
    const stale = tapeIsStaleTs(newestTs)

    if (isColdStart) {
      // First time this store has ever seen this token — scan the FULL DEEP_BACKFILL_BLOCKS
      // window in one shot, all the way to `head`, not just a CATCHUP_MAX_BLOCKS-bounded slice of
      // it. This used to seed the cursor 300k back and then only scan 200k forward from there —
      // which left the most recent 100k blocks (DEEP_BACKFILL_BLOCKS - CATCHUP_MAX_BLOCKS)
      // completely unscanned on a token's very first view. A brand-new, actively-traded token
      // (all its history within the last 100k blocks) would show zero trades on its first ever
      // page load, self-healing only on a second visit once the cursor caught up. One-time cost —
      // ~34 chunked eth_getLogs calls worst case — is worth paying once per token to never miss
      // recent activity on a cold view.
      const from = head >= DEEP_BACKFILL_BLOCKS ? head - DEEP_BACKFILL_BLOCKS + 1n : 0n
      const found = await scanSwapRange(client, pool, tokenIs0, tokenDecimals, from, head, quoteDecimals)
      if (
        shouldPersistScanCursor({
          foundTrades: found.trades.length,
          scannedTo: found.scannedTo,
          from,
          tapeIsStale: stale,
        })
      ) {
        await persistTrades(key, found.trades, found.scannedTo)
      }
    } else if (cursor! < head) {
      // Warm — only scan the gap since the last time anyone loaded this token, capped per
      // request so a token idle a long time just catches up over however many page loads it takes.
      const from = cursor! + 1n
      const to = from + CATCHUP_MAX_BLOCKS - 1n > head ? head : from + CATCHUP_MAX_BLOCKS - 1n
      const found = await scanSwapRange(client, pool, tokenIs0, tokenDecimals, from, to, quoteDecimals)
      if (
        shouldPersistScanCursor({
          foundTrades: found.trades.length,
          scannedTo: found.scannedTo,
          from,
          tapeIsStale: stale,
        })
      ) {
        await persistTrades(key, found.trades, found.scannedTo)
      }
    }
    // Cursor at head can still be a lie: empty getLogs from a public RPC parks it there.
    // Rewind from the last persisted fill, not a fixed 12k-block window.
    await maybeRewindStaleCursor(client, key, pool, tokenIs0, tokenDecimals, head, quoteDecimals)
  })

  if (didWork) lastSyncedAt.set(key, Date.now())
}

/**
 * Refresh a token's trades AFTER the current response is sent, matching the pattern already
 * proven in lib/arc-catalog-cache.ts's scheduleRefresh — this is the same "return what's cached,
 * refresh in the background" shape applied to trades instead of the home catalog. `run` never
 * awaits the sync, so even the defensive fallback (after() throws outside a request-scoped
 * context — a Route Handler, Server Component, or Server Action; the cron and the local-indexer
 * script both call syncTradesToHead directly, bypassing this) stays non-blocking.
 */
function scheduleTradesSync(token: Address): void {
  const run = () => {
    void syncTradesToHead(token).catch((e) =>
      console.warn('[arc-trades] background sync', token, summarizeRpcError(e)),
    )
  }
  try {
    after(run)
  } catch {
    run()
  }
}

export interface FetchArcTradesOpts {
  /** Page size. Defaults to MAX_TRADES (50). */
  limit?: number
  /** How many of the newest trades to skip — 0 is page 1, `limit` is page 2, etc. */
  offset?: number
}

export async function fetchArcTrades(
  token: Address,
  opts: FetchArcTradesOpts = {},
): Promise<EvmTradesResult> {
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, TRADES_CAP) : MAX_TRADES
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0
  const key = token.toLowerCase()
  const cacheKey = `${key}:${offset}:${limit}`
  const hit = mem.get(cacheKey)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.result

  try {
    // Block only on a token's genuine first-ever view — no cursor means nothing has ever been
    // indexed for it, so there's nothing to return without syncing first (same shape as
    // arc-catalog-cache.ts's rebuild() fallback for a true cold start). Every other case has
    // *something* already in KV: return that immediately and refresh in the background via
    // scheduleTradesSync, so the viewer isn't the one paying for the scan. This was the actual
    // remaining latency after the coalescing fix — coalescing stopped N concurrent requests from
    // each triggering their own scan, but the one scan that *did* run still blocked the response
    // it was attached to. The client already polls every 8s (app/token/[address]/page.tsx), well
    // past SYNC_FRESH_MS (6s), so a page that briefly shows stale/empty data self-heals on its
    // own next poll without any client change.
    let cursorExists = true
    let newestTs = 0
    try {
      cursorExists = (await kv.get<string | number>(cursorKvKey(key))) != null
      const tail = (await kv.lrange<EvmTrade>(tradesKvKey(key), -1, -1)) ?? []
      newestTs = tail[0]?.ts || 0
    } catch {
      cursorExists = true // a failed check must not force the slow cold-start path
    }

    // Cold start has nothing to show. A stale tape (newest fill >20 min) used to
    // return immediately and refresh in after() — if that scan used a public RPC
    // that answered [], the page kept serving 3h-old trades forever (EVE 2026-09-01).
    if (!cursorExists || tapeIsStaleTs(newestTs)) {
      await syncTradesToHead(token)
    } else {
      scheduleTradesSync(token)
    }

    // Stored ascending (oldest→newest); newest page (offset 0) is the tail of the list. Redis
    // LRANGE with negative indices counts from the end, so page N's ascending slice is
    // [-(offset+limit), -(offset+1)] — clamped to the list start automatically for an
    // out-of-range negative start (e.g. a deep offset on a short list just returns fewer rows).
    let stored: EvmTrade[] | null = null
    try {
      stored = await kv.lrange<EvmTrade>(tradesKvKey(key), 0, -1)
    } catch (e) {
      console.warn('[arc-trades] kv read trades', summarizeRpcError(e))
    }
    // syncTradesToHead already persisted anything newly scanned; a failure here is this specific
    // read failing right after that write succeeded, not a sign nothing was found. Empty rather
    // than wrong — the next call (this freshness window or the next) reads the real list.
    if (stored === null) stored = []

    const cleaned = dedupeTrades(stored)
    if (stored.length !== cleaned.length) {
      try {
        await kv.del(tradesKvKey(key))
        if (cleaned.length > 0) {
          await kv.rpush(tradesKvKey(key), ...cleaned)
          const ids = cleaned.map(tradeId)
          if (ids.length) await kv.sadd(seenKvKey(key), ids[0], ...ids.slice(1))
        }
      } catch (e) {
        console.warn('[arc-trades] kv dedupe rewrite', summarizeRpcError(e))
      }
    }

    const total = cleaned.length
    const ascending = cleaned.slice(Math.max(0, cleaned.length - (offset + limit)), Math.max(0, cleaned.length - offset))

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
      total,
    }
    mem.set(cacheKey, { result, at: Date.now() })
    return result
  } catch (e) {
    console.error('[arc-trades]', summarizeRpcError(e))
    return empty
  }
}
