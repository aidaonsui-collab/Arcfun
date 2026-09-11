/**
 * Arc event indexer cycle — factories, swap catch-up + volume.
 * OTC is owned entirely by /api/arc/indexer/otc; see runArcIndexerCycle for why.
 * Designed for Vercel Cron (maxDuration 300): incremental cursors, bounded chunks.
 */
import { parseAbiItem, type Address, type Hex } from 'viem'
import { ARC, arcPublicClient, arcLogsClient, arcInstantEnabled, arcReflectionEnabled } from '@/lib/contracts-arc'
import { arcMarketCapUsd, healIndexedSpotUsdc, healSparkCloses, instantCatalogFactories } from '@/lib/arc-instant-tokens'
import { lastSparkClose } from '@/lib/arc-catalog-from-index'
import { syncTradesToHead } from '@/lib/arc-trades'
import { allInMultiplier, fetchOtcFeeBps } from '@/lib/bridge/robin-otc'
import { scanLogsChunked } from './logs'
import {
  loadState,
  saveState,
  upsertToken,
  getToken,
  listIndexedTokens,
  listTokenAddresses,
  setVolume,
  getVolumesMap,
  listOtcOffers,
  kvConfigured,
  tokenCount,
  otcOfferCount,
  countOrNull,
} from './store'
import { computeVolumeWindows } from './volume'
import type { IndexedLaunchKind, IndexedToken, IndexerState } from './types'
import { summarizeRpcError } from '@/lib/rpc-error'
import { indexerWorkerName } from './lease'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

const INSTANT_CREATED = parseAbiItem(
  'event InstantQuoteTokenCreated(address indexed token, address indexed creator, address pool, uint256 positionId)',
)
const REFLECTION_CREATED = parseAbiItem(
  'event InstantReflectionCreated(address indexed token, address indexed creator, address rewardToken, address pool, uint256 positionId, address feeSink)',
)

/** Known floors so first run doesn't scan from genesis. */
const FACTORY_FLOOR = 14_000_000n

const MAX_FACTORY_CHUNKS = 24
/**
 * How many tokens to catch up per cron tick (swap + volume), split two ways.
 *
 * HOT_BATCH: recomputed fresh every cycle from cached IndexedVolume.lastTradeAt (a single
 * kv.mget, no RPC) — whichever tokens are currently most active get synced close to every
 * cycle, not once per full rotation. Previously a single flat SWAP_BATCH=8 round-robinned ALL
 * tokens with identical cadence: with 29 tokens that's ~4 cycles / 8 minutes before a token's
 * proactive turn came around again, whether it was the hottest token on the pad or dead.
 *
 * ROTATE_BATCH: the original round-robin, unchanged in mechanism, over the stable
 * listIndexedTokens() order — this is what still guarantees every token, including quiet ones,
 * gets touched eventually. That matters for correctness, not just freshness: computeVolumeWindows
 * recomputes rolling 1h/6h/12h/24h windows from the persisted trade tape each time it runs: a
 * token that stops getting a turn doesn't decay to zero as its old trades age out of those
 * windows, it just freezes at its last-computed values.
 */
const HOT_BATCH = 8
const ROTATE_BATCH = 12

/**
 * Wall-clock budget for one cron cycle. The route's maxDuration is 300s; this leaves ~60s for
 * cold start, the closing saveState + count reads, and the response. Without it, a cycle where
 * Arc's public RPCs are slow runs every token's trade-sync + lifetime volume scan long past 300s,
 * gets killed mid-run, saves nothing, and the next cycle restarts from the same cursor — a
 * permanent stall until the RPCs recover (observed 2026-09-10: ~20 min of back-to-back 504s, the
 * volume store frozen the whole time). With the budget the cycle stops early and saves partial
 * progress, so the hot tokens still refresh every cycle and the rotation resumes where it left off.
 *
 * INDEXER_CYCLE_BUDGET_MS overrides it — a long-running daemon (lib/arc-indexer/daemon.ts) that
 * isn't bounded by a 300s function limit can raise it.
 */
const CYCLE_BUDGET_MS = (() => {
  const raw = Number(process.env.INDEXER_CYCLE_BUDGET_MS)
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 240_000
})()

const ALL_TOKENS_ABI = [
  {
    type: 'function',
    name: 'allTokensLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allTokens',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

async function seedTokensFromFactories(): Promise<number> {
  const client = arcPublicClient()
  let added = 0

  const seedFactory = async (factory: Address, kind: IndexedLaunchKind) => {
    if (!factory || factory === ZERO) return
    try {
      const len = Number(
        await client.readContract({
          address: factory,
          abi: ALL_TOKENS_ABI,
          functionName: 'allTokensLength',
        }),
      )
      if (!Number.isFinite(len) || len <= 0) return
      const max = Math.min(len, 200)
      for (let i = len - 1; i >= len - max && i >= 0; i--) {
        const token = (await client.readContract({
          address: factory,
          abi: ALL_TOKENS_ABI,
          functionName: 'allTokens',
          args: [BigInt(i)],
        })) as Address
        if (!token || token === ZERO) continue
        const existing = await getToken(token)
        if (existing) continue
        // Do not stamp Date.now() as createdAt — that made "New" mean "first indexed".
        await upsertToken({
          token,
          creator: ZERO,
          pool: ZERO,
          factory,
          kind,
          createdAt: 0,
        })
        added++
      }
    } catch (e) {
      console.warn('[arc-indexer] seed factory', factory, summarizeRpcError(e))
    }
  }

  if (arcInstantEnabled()) {
    for (const f of instantCatalogFactories()) await seedFactory(f, 'instant')
  }
  if (arcReflectionEnabled()) await seedFactory(ARC.REFLECTION_FACTORY, 'reflection')

  return added
}

async function scanFactoryEvents(
  state: IndexerState,
  head: bigint,
): Promise<{ state: IndexerState; found: number }> {
  const client = arcLogsClient()
  let cursor = BigInt(state.factoryCursor || '0')
  if (cursor === 0n) cursor = FACTORY_FLOOR > 0n ? FACTORY_FLOOR : 0n
  if (cursor >= head) return { state, found: 0 }

  const from = cursor + 1n
  let found = 0

  if (arcInstantEnabled()) {
    let scannedTo = from
    for (const factory of instantCatalogFactories()) {
      const scanned = await scanLogsChunked(client, {
        address: factory,
        event: INSTANT_CREATED,
        fromBlock: from,
        toBlock: head,
        maxChunks: MAX_FACTORY_CHUNKS,
      })
      if (scanned.scannedTo > scannedTo) scannedTo = scanned.scannedTo
      for (const log of scanned.logs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = (log as any).args as {
          token?: Address
          creator?: Address
          pool?: Address
        }
        if (!args?.token) continue
        const createdBlock = Number(log.blockNumber ?? 0n)
        let createdAt = 0
        try {
          if (log.blockNumber != null) {
            const block = await client.getBlock({ blockNumber: log.blockNumber })
            createdAt = Number(block.timestamp)
          }
        } catch {
          /* attachLaunchCreatedAt backfills */
        }
        await upsertToken({
          token: args.token,
          creator: args.creator || ZERO,
          pool: args.pool || ZERO,
          factory,
          kind: 'instant',
          createdAt,
          createdBlock,
        })
        found++
      }
    }
    state = { ...state, factoryCursor: scannedTo.toString() }
  }

  if (arcReflectionEnabled() && ARC.REFLECTION_FACTORY !== ZERO) {
    const start = from
    const { logs, scannedTo } = await scanLogsChunked(client, {
      address: ARC.REFLECTION_FACTORY,
      event: REFLECTION_CREATED,
      fromBlock: start,
      toBlock: head,
      maxChunks: MAX_FACTORY_CHUNKS,
    })
    for (const log of logs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (log as any).args as {
        token?: Address
        creator?: Address
        pool?: Address
      }
      if (!args?.token) continue
      const createdBlock = Number(log.blockNumber ?? 0n)
      let createdAt = 0
      try {
        if (log.blockNumber != null) {
          const block = await client.getBlock({ blockNumber: log.blockNumber })
          createdAt = Number(block.timestamp)
        }
      } catch {
        /* attachLaunchCreatedAt backfills */
      }
      await upsertToken({
        token: args.token,
        creator: args.creator || ZERO,
        pool: args.pool || ZERO,
        factory: ARC.REFLECTION_FACTORY,
        kind: 'reflection',
        createdAt,
        createdBlock,
      })
      found++
    }
    // Keep factory cursor at max scanned so we don't re-read forever
    const prev = BigInt(state.factoryCursor || '0')
    const next = scannedTo > prev ? scannedTo : prev
    state = { ...state, factoryCursor: next.toString() }
  }

  return { state, found }
}

async function catchUpSwapsAndVolume(
  state: IndexerState,
  deadline: number,
): Promise<{ state: IndexerState; tokens: number; budgetHit: boolean }> {
  const all = await listIndexedTokens()
  if (!all.length) return { state, tokens: 0, budgetHit: false }

  // Hottest first, but a tape that stopped updating ranks above a token that
  // genuinely just traded: lastTradeAt 3h ago with a cursor at head is the EVE
  // freeze (2026-09-01), and those are the ones that need a getLogs retry.
  const volumes = await getVolumesMap(all.map((t) => t.token))
  const now = Math.floor(Date.now() / 1000)
  const STALE_SEC = 20 * 60
  const lastAt = (t: IndexedToken) => volumes[t.token.toLowerCase()]?.lastTradeAt ?? 0
  const isStale = (t: IndexedToken) => {
    const ts = lastAt(t)
    return ts > 0 && now - ts >= STALE_SEC
  }
  const byNeed = [...all].sort((a, b) => {
    const as = isStale(a)
    const bs = isStale(b)
    if (as !== bs) return as ? -1 : 1
    const ta = lastAt(a) || now
    const tb = lastAt(b) || now
    return tb - ta
  })
  const hot = byNeed.slice(0, HOT_BATCH)

  // Round-robin over the STABLE listIndexedTokens() order (not byNeed, which reshuffles every
  // cycle as volumes change) — a rotating index into a list that keeps reordering under it would
  // risk skipping tokens or revisiting others, defeating the coverage guarantee this exists for.
  const start = state.swapRotate % all.length
  const rotated: IndexedToken[] = []
  for (let i = 0; i < Math.min(ROTATE_BATCH, all.length); i++) {
    rotated.push(all[(start + i) % all.length])
  }

  let n = 0
  let budgetHit = false
  const processed = new Set<string>()

  // Returns false only when the wall-clock budget is spent *before* this token's work starts —
  // the caller uses that to stop without counting the token as covered. A dedupe hit or an RPC
  // error still returns true (the slot is done; retrying it forever gains nothing).
  const runOne = async (t: IndexedToken): Promise<boolean> => {
    const key = t.token.toLowerCase()
    if (processed.has(key)) return true
    if (Date.now() >= deadline) {
      budgetHit = true
      return false
    }
    processed.add(key)
    try {
      // Sync directly rather than via fetchArcTrades: this call never used fetchArcTrades's
      // return value, only its blocking sync side effect, and computeVolumeWindows right below
      // reads the same arcfun:trades:* KV state syncTradesToHead just wrote. fetchArcTrades now
      // returns immediately and refreshes stale tokens in the background (see fetchArcTrades's
      // own comment) — right for a page view, wrong here, where volume must reflect this cycle's
      // sync, not whatever was cached before it.
      await syncTradesToHead(t.token as Address)
      const vol = await computeVolumeWindows(t.token)
      await setVolume(t.token, vol)
      n++
    } catch (e) {
      console.warn('[arc-indexer] swap/volume', t.token, summarizeRpcError(e))
    }
    return true
  }

  // Hot tokens first — the ones people are actually looking at get refreshed even on a cycle
  // that never reaches the rotation.
  for (const t of hot) {
    if (!(await runOne(t))) break
  }

  // Then the round-robin. The cursor advances only past slots we actually reached, so a cycle
  // cut short by the budget resumes here next time instead of skipping quiet tokens.
  let rotatedConsumed = 0
  for (const t of rotated) {
    if (!(await runOne(t))) break
    rotatedConsumed++
  }

  return {
    state: {
      ...state,
      // Advances by what the ROTATION portion consumed, not the de-duplicated combined batch —
      // otherwise overlap with the hot set (a currently-hot token that also happened to be next
      // in line) would advance the pointer too slowly, or leave it stuck if the two kept
      // overlapping, defeating the coverage guarantee.
      swapRotate: (start + rotatedConsumed) % Math.max(all.length, 1),
    },
    tokens: n,
    budgetHit,
  }
}

export type IndexerRunResult = {
  ok: boolean
  ms: number
  /** true when the cycle stopped on CYCLE_BUDGET_MS before finishing the token batch. */
  budgetHit?: boolean
  kvConfigured: boolean
  seeded: number
  factories: number
  /** Always 0 — this cron no longer scans OTC. Kept so the status/response shape is unchanged. */
  otcOffers: number
  swapsTokens: number
  tokenCount: number
  otcOfferCount: number
  state: IndexerState
  error?: string
}

export async function runArcIndexerCycle(): Promise<IndexerRunResult> {
  const t0 = Date.now()
  const deadline = t0 + CYCLE_BUDGET_MS
  let seeded = 0
  let factories = 0
  let otcOffers = 0
  let swapsTokens = 0
  let budgetHit = false

  // Load state BEFORE the try that ends in saveState(). A failed KV read must abort the whole
  // cycle without writing anything: loadState()'s zeroed default is only correct for a genuine
  // first run, and persisting it after a read failure wipes the real cursor and triggers a full
  // re-scan from the floor. See KvUnavailableError in ./store. Bailing here is safe — the cron
  // runs every 2 minutes, so we just skip this tick and retry once KV recovers.
  let state: IndexerState
  try {
    state = await loadState()
  } catch (e) {
    const ms = Date.now() - t0
    const error = e instanceof Error ? e.message : String(e)
    console.error('[arc-indexer] state read unavailable — skipping cycle without saving', error)
    return {
      ok: false,
      ms,
      kvConfigured: kvConfigured(),
      seeded,
      factories,
      otcOffers,
      swapsTokens,
      tokenCount: (await countOrNull(tokenCount)) ?? 0,
      otcOfferCount: (await countOrNull(otcOfferCount)) ?? 0,
      state: {
        version: 1,
        factoryCursor: '0',
        otcCursor: '0',
        swapRotate: 0,
        updatedAt: 0,
      },
      error: `state unavailable, cycle skipped: ${error}`,
    }
  }

  try {
    // Throws KvUnavailableError if the read failed; caught by the outer catch, which records
    // lastRun.ok=false and leaves the cursor untouched. Only a genuinely empty registry seeds.
    const existing = await listTokenAddresses()
    if (existing.length === 0) {
      seeded = await seedTokensFromFactories()
    }

    const client = arcLogsClient()
    const head = await client.getBlockNumber()

    try {
      const f = await scanFactoryEvents(state, head)
      state = f.state
      factories = f.found
    } catch (e) {
      // A dead getLogs must not skip swap catch-up — that froze EVE's tape while RadarDEX
      // kept filling (2026-09-01: "failed all 1 log chunks" aborted the whole cycle).
      console.warn('[arc-indexer] factory scan', summarizeRpcError(e))
    }

    // OTC is deliberately NOT touched here — /api/arc/indexer/otc owns it end to end and runs
    // every minute (this cron every two), so everything below was pure duplicate work, and worse:
    //
    //  - Both crons advanced the SAME state.otcCursor with an unsynchronised read-modify-write.
    //    Two overlapping ticks could each load state, scan, and save — the later save clobbering
    //    the earlier cursor, re-scanning or skipping OfferCreated ranges.
    //  - the refreshOtcOfferState() this replaced still removed an offer on a single
    //    remaining === 0n read — the exact bug fixed in the OTC cron in #123. Keeping it meant
    //    this cron re-deleted live maker offers every two minutes, silently undoing that fix.
    //  - catchUpOtcDeskStats() likewise raced its own per-chain settledCursor between the two.
    //
    // One owner per dataset: this cron does factories + swaps/volume, the OTC cron does OTC.
    // Skip the phase entirely if the factory scan already ate the budget — still fall through
    // to saveState so the factory cursor progress isn't lost.
    if (Date.now() < deadline) {
      const s = await catchUpSwapsAndVolume(state, deadline)
      state = s.state
      swapsTokens = s.tokens
      budgetHit = s.budgetHit
    } else {
      budgetHit = true
    }

    const ms = Date.now() - t0
    state = {
      ...state,
      lastRun: {
        at: Date.now(),
        ok: true,
        ms,
        factories,
        otcOffers,
        swapsTokens,
        budgetHit,
        worker: indexerWorkerName(),
      },
    }
    await saveState(state)

    return {
      ok: true,
      ms,
      budgetHit,
      kvConfigured: kvConfigured(),
      seeded,
      factories,
      otcOffers,
      swapsTokens,
      tokenCount: (await countOrNull(tokenCount)) ?? 0,
      otcOfferCount: (await countOrNull(otcOfferCount)) ?? 0,
      state,
    }
  } catch (e) {
    const ms = Date.now() - t0
    const error = e instanceof Error ? e.message : String(e)
    state = {
      ...state,
      lastRun: {
        at: Date.now(),
        ok: false,
        ms,
        factories,
        otcOffers,
        swapsTokens,
        error,
        worker: indexerWorkerName(),
      },
    }
    await saveState(state)
    console.error('[arc-indexer] cycle failed', summarizeRpcError(e))
    return {
      ok: false,
      ms,
      kvConfigured: kvConfigured(),
      seeded,
      factories,
      otcOffers,
      swapsTokens,
      tokenCount: (await countOrNull(tokenCount)) ?? 0,
      otcOfferCount: (await countOrNull(otcOfferCount)) ?? 0,
      state,
      error,
    }
  }
}

/**
 * Catalog enrichment from the indexer snapshot (`arcfun:idx:vol:*`).
 * Do not re-lrange 400 trades per token here — that was the home-grid stall.
 */
export async function enrichTokensWithIndexVolume<
  T extends { coinType?: string; poolId?: string; volume1h?: number; priceChange24h?: number },
>(tokens: T[]): Promise<T[]> {
  if (tokens.length === 0) return tokens
  const { getVolumesMap } = await import('./store')
  const map = await getVolumesMap(tokens.map((t) => t.coinType || t.poolId || ''))
  return tokens.map((t) => {
    const id = (t.coinType || t.poolId || '').toLowerCase()
    const v = id ? map[id] : undefined
    if (!v) return t
    const lastPrice = healIndexedSpotUsdc(lastSparkClose(v))
    const sparkCloses = healSparkCloses(v.sparkCloses) ?? v.sparkCloses
    return {
      ...t,
      volume1h: v.volume1h,
      volume6h: v.volume6h,
      volume12h: v.volume12h,
      volume24h: v.volume24h,
      volumeAll: v.volumeAll,
      lastTradeAt: v.lastTradeAt || (t as { lastTradeAt?: number }).lastTradeAt,
      priceChange24h: v.priceChange24h ?? t.priceChange24h ?? 0,
      sparkCloses,
      ...(lastPrice > 0
        ? { currentPrice: lastPrice, marketCap: arcMarketCapUsd(lastPrice) }
        : {}),
    }
  })
}

/** Live OTC book from index + fee mult. */
export async function getIndexedOtcBook() {
  const offers = await listOtcOffers()
  const feeBps = await fetchOtcFeeBps().catch(() => 200)
  return offers
    .filter((o) => o.active && BigInt(o.remaining || '0') > 0n)
    .map((o) => {
      const remaining = BigInt(o.remaining || '0')
      return {
        offerId: o.offerId,
        maker: o.maker,
        sellerPayment: o.sellerPayment,
        premiumBps: o.premiumBps,
        remaining,
        active: o.active,
        allInMult: allInMultiplier(o.premiumBps, feeBps),
        available: remaining,
        pendingReserved: 0n,
        hasPending: false,
      }
    })
    .sort(
      (a, b) =>
        (a.allInMult ?? 99) - (b.allInMult ?? 99) ||
        Number(b.available - a.available),
    )
}
