/**
 * Arc event indexer cycle — factories, OTC offers, swap catch-up + volume.
 * Designed for Vercel Cron (maxDuration 300): incremental cursors, bounded chunks.
 */
import { parseAbiItem, type Address, type Hex } from 'viem'
import { ARC, arcPublicClient, arcInstantEnabled, arcReflectionEnabled } from '@/lib/contracts-arc'
import { fetchArcTrades } from '@/lib/arc-trades'
import {
  ROBIN_OTC_LIQUIDITY,
  LIQUIDITY_ABI,
  robinOtcEnabled,
  allInMultiplier,
  fetchOtcFeeBps,
} from '@/lib/bridge/robin-otc'
import { scanLogsChunked } from './logs'
import {
  loadState,
  saveState,
  upsertToken,
  listIndexedTokens,
  listTokenAddresses,
  setVolume,
  upsertOtcOffer,
  removeOtcOffer,
  listOtcOffers,
  kvConfigured,
  tokenCount,
  otcOfferCount,
} from './store'
import { computeVolumeWindows } from './volume'
import type { IndexedLaunchKind, IndexedToken, IndexerState } from './types'
import { summarizeRpcError } from '@/lib/rpc-error'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

const INSTANT_CREATED = parseAbiItem(
  'event InstantQuoteTokenCreated(address indexed token, address indexed creator, address pool, uint256 positionId)',
)
const REFLECTION_CREATED = parseAbiItem(
  'event InstantReflectionCreated(address indexed token, address indexed creator, address rewardToken, address pool, uint256 positionId, address feeSink)',
)
const OFFER_CREATED = parseAbiItem(
  'event OfferCreated(bytes32 indexed offerId, address indexed maker, address sellerPayment, uint32 premiumBps, uint256 amount)',
)

/** Known floors so first run doesn't scan from genesis. */
const FACTORY_FLOOR = 14_000_000n
const OTC_FLOOR = 14_000_000n

const MAX_FACTORY_CHUNKS = 24
const MAX_OTC_CHUNKS = 24
/** How many tokens to catch up per cron tick (swap + volume). */
const SWAP_BATCH = 8

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
        // Pool/creator resolved lazily via fetchArcTrades / fetchArcPoolToken.
        await upsertToken({
          token,
          creator: ZERO,
          pool: ZERO,
          factory,
          kind,
          createdAt: Math.floor(Date.now() / 1000),
        })
        added++
      }
    } catch (e) {
      console.warn('[arc-indexer] seed factory', factory, summarizeRpcError(e))
    }
  }

  if (arcInstantEnabled()) await seedFactory(ARC.INSTANT_FACTORY, 'instant')
  if (arcReflectionEnabled()) await seedFactory(ARC.REFLECTION_FACTORY, 'reflection')

  return added
}

async function scanFactoryEvents(
  state: IndexerState,
  head: bigint,
): Promise<{ state: IndexerState; found: number }> {
  const client = arcPublicClient()
  let cursor = BigInt(state.factoryCursor || '0')
  if (cursor === 0n) cursor = FACTORY_FLOOR > 0n ? FACTORY_FLOOR : 0n
  if (cursor >= head) return { state, found: 0 }

  const from = cursor + 1n
  let found = 0

  if (arcInstantEnabled() && ARC.INSTANT_FACTORY !== ZERO) {
    const { logs, scannedTo } = await scanLogsChunked(client, {
      address: ARC.INSTANT_FACTORY,
      event: INSTANT_CREATED,
      fromBlock: from,
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
      await upsertToken({
        token: args.token,
        creator: args.creator || ZERO,
        pool: args.pool || ZERO,
        factory: ARC.INSTANT_FACTORY,
        kind: 'instant',
        createdAt: Math.floor(Date.now() / 1000),
        createdBlock: Number(log.blockNumber ?? 0n),
      })
      found++
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
      await upsertToken({
        token: args.token,
        creator: args.creator || ZERO,
        pool: args.pool || ZERO,
        factory: ARC.REFLECTION_FACTORY,
        kind: 'reflection',
        createdAt: Math.floor(Date.now() / 1000),
        createdBlock: Number(log.blockNumber ?? 0n),
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

async function scanOtcOffers(
  state: IndexerState,
  head: bigint,
): Promise<{ state: IndexerState; offers: number }> {
  if (!robinOtcEnabled() || ROBIN_OTC_LIQUIDITY === ZERO) {
    return { state, offers: 0 }
  }
  const client = arcPublicClient()
  let cursor = BigInt(state.otcCursor || '0')
  if (cursor === 0n) cursor = OTC_FLOOR
  if (cursor >= head) {
    // Still refresh remaining on known offers
    await refreshOtcOfferState()
    return { state, offers: 0 }
  }

  const from = cursor + 1n
  const { logs, scannedTo } = await scanLogsChunked(client, {
    address: ROBIN_OTC_LIQUIDITY,
    event: OFFER_CREATED,
    fromBlock: from,
    toBlock: head,
    maxChunks: MAX_OTC_CHUNKS,
  })

  let n = 0
  for (const log of logs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (log as any).args as {
      offerId?: Hex
      maker?: Address
      sellerPayment?: Address
      premiumBps?: number
      amount?: bigint
    }
    if (!args?.offerId) continue
    await upsertOtcOffer({
      offerId: args.offerId,
      maker: args.maker || ZERO,
      sellerPayment: args.sellerPayment || ZERO,
      premiumBps: Number(args.premiumBps ?? 0),
      remaining: (args.amount ?? 0n).toString(),
      active: true,
      createdBlock: Number(log.blockNumber ?? 0n),
      updatedAt: Date.now(),
    })
    n++
  }

  await refreshOtcOfferState()
  return { state: { ...state, otcCursor: scannedTo.toString() }, offers: n }
}

async function refreshOtcOfferState(): Promise<void> {
  if (!robinOtcEnabled()) return
  const client = arcPublicClient()
  const offers = await listOtcOffers()
  for (const o of offers) {
    try {
      const row = (await client.readContract({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'offers',
        args: [o.offerId],
      })) as readonly [Address, Address, number, bigint, boolean]
      const [maker, sellerPayment, premiumBps, remaining, active] = row
      if (!active || remaining === 0n) {
        await removeOtcOffer(o.offerId)
        continue
      }
      await upsertOtcOffer({
        offerId: o.offerId,
        maker,
        sellerPayment,
        premiumBps: Number(premiumBps),
        remaining: remaining.toString(),
        active,
        createdBlock: o.createdBlock,
        updatedAt: Date.now(),
      })
    } catch {
      /* keep prior */
    }
  }
}

async function catchUpSwapsAndVolume(
  state: IndexerState,
): Promise<{ state: IndexerState; tokens: number }> {
  const all = await listIndexedTokens()
  if (!all.length) return { state, tokens: 0 }

  const start = state.swapRotate % all.length
  const batch: IndexedToken[] = []
  for (let i = 0; i < Math.min(SWAP_BATCH, all.length); i++) {
    batch.push(all[(start + i) % all.length])
  }

  let n = 0
  for (const t of batch) {
    try {
      // Reuses per-token KV trade index (cold backfill / warm catch-up)
      await fetchArcTrades(t.token as Address, { limit: 20 })
      const vol = await computeVolumeWindows(t.token)
      await setVolume(t.token, vol)
      n++
    } catch (e) {
      console.warn('[arc-indexer] swap/volume', t.token, summarizeRpcError(e))
    }
  }

  return {
    state: {
      ...state,
      swapRotate: (start + batch.length) % Math.max(all.length, 1),
    },
    tokens: n,
  }
}

export type IndexerRunResult = {
  ok: boolean
  ms: number
  kvConfigured: boolean
  seeded: number
  factories: number
  otcOffers: number
  swapsTokens: number
  tokenCount: number
  otcOfferCount: number
  state: IndexerState
  error?: string
}

export async function runArcIndexerCycle(): Promise<IndexerRunResult> {
  const t0 = Date.now()
  let state = await loadState()
  let seeded = 0
  let factories = 0
  let otcOffers = 0
  let swapsTokens = 0

  try {
    const existing = await listTokenAddresses()
    if (existing.length === 0) {
      seeded = await seedTokensFromFactories()
    }

    const client = arcPublicClient()
    const head = await client.getBlockNumber()

    const f = await scanFactoryEvents(state, head)
    state = f.state
    factories = f.found

    const o = await scanOtcOffers(state, head)
    state = o.state
    otcOffers = o.offers

    const s = await catchUpSwapsAndVolume(state)
    state = s.state
    swapsTokens = s.tokens

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
      },
    }
    await saveState(state)

    return {
      ok: true,
      ms,
      kvConfigured: kvConfigured(),
      seeded,
      factories,
      otcOffers,
      swapsTokens,
      tokenCount: await tokenCount(),
      otcOfferCount: await otcOfferCount(),
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
      tokenCount: await tokenCount(),
      otcOfferCount: await otcOfferCount(),
      state,
      error,
    }
  }
}

/** Catalog enrichment helper. */
export async function enrichTokensWithIndexVolume<
  T extends { coinType?: string; poolId?: string; volume1h?: number },
>(tokens: T[]): Promise<T[]> {
  const { getVolumesMap } = await import('./store')
  const ids = tokens.map((t) => (t.coinType || t.poolId || '').toLowerCase()).filter(Boolean)
  const vols = await getVolumesMap(ids)
  return tokens.map((t) => {
    const id = (t.coinType || t.poolId || '').toLowerCase()
    const v = vols[id]
    if (!v) return t
    return {
      ...t,
      volume1h: v.volume1h,
      volume6h: v.volume6h,
      volume12h: v.volume12h,
      volume24h: v.volume24h,
      lastTradeAt: v.lastTradeAt || (t as { lastTradeAt?: number }).lastTradeAt,
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
