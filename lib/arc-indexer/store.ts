/**
 * Arc indexer persistence — Vercel KV (`arcfun:idx:*`).
 * Degrades gracefully when KV is missing (local dev without Upstash).
 */
import { kv } from '@vercel/kv'
import type { Address, Hex } from 'viem'
import type { IndexedOtcOffer, IndexedToken, IndexedVolume, IndexerState } from './types'
import { summarizeRpcError } from '@/lib/rpc-error'

const STATE_KEY = 'arcfun:idx:state'
const TOKEN_SET = 'arcfun:idx:tokens'
const tokenKey = (t: string) => `arcfun:idx:token:${t.toLowerCase()}`
const volumeKey = (t: string) => `arcfun:idx:vol:${t.toLowerCase()}`
const OTC_OFFER_SET = 'arcfun:idx:otc:offers'
const otcOfferKey = (id: string) => `arcfun:idx:otc:offer:${id.toLowerCase()}`

export function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

/**
 * Thrown when a KV read FAILED, as distinct from a key that is genuinely absent.
 *
 * Found live 2026-08-21: every read here used to swallow the error and return null/[], so a
 * rate-limited or timed-out Upstash read was indistinguishable from "there is no data". That
 * fed a destructive loop — loadState() returned a zeroed default, the cycle did its work
 * against that phantom state, then saveState() PERSISTED the reset cursor, wiping the real one
 * and forcing a full re-scan from the floor (more KV + RPC load → more rate limiting → more
 * resets). Observed directly: six identical /api/arc/indexer/status calls seconds apart
 * returned factoryCursor 16761463, 16761463, 16761463, 0, 0, 0 and tokenCount 18/18/18/0/0/18.
 *
 * Callers that mutate persisted state MUST let this propagate and abort without saving.
 * Read-only callers (status route) may catch it and report degraded.
 */
export class KvUnavailableError extends Error {
  constructor(op: string, cause?: unknown) {
    super(`kv ${op} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'KvUnavailableError'
  }
}

/** Read that distinguishes "missing" (null) from "unavailable" (throws). */
async function strictGet<T>(key: string): Promise<T | null> {
  try {
    return (await kv.get<T>(key)) ?? null
  } catch (e) {
    console.warn('[arc-indexer] kv get', key, summarizeRpcError(e))
    throw new KvUnavailableError(`get ${key}`, e)
  }
}

/** Best-effort read for non-critical paths — a failure here cannot corrupt persisted state. */
async function safeGet<T>(key: string): Promise<T | null> {
  try {
    return await strictGet<T>(key)
  } catch {
    return null
  }
}

async function safeSet(key: string, value: unknown, ex?: number): Promise<void> {
  try {
    if (ex != null) await kv.set(key, value, { ex })
    else await kv.set(key, value)
  } catch (e) {
    console.warn('[arc-indexer] kv set', key, summarizeRpcError(e))
  }
}

/**
 * Throws KvUnavailableError if the state read fails — callers that go on to saveState() must
 * NOT treat that as a fresh/empty index (see KvUnavailableError). A genuinely absent key still
 * returns the zeroed default, which is the correct first-run behaviour.
 */
export async function loadState(): Promise<IndexerState> {
  const s = await strictGet<IndexerState>(STATE_KEY)
  if (s?.version === 1) return s
  return {
    version: 1,
    factoryCursor: '0',
    otcCursor: '0',
    swapRotate: 0,
    updatedAt: 0,
  }
}

export async function saveState(state: IndexerState): Promise<void> {
  await safeSet(STATE_KEY, { ...state, updatedAt: Date.now() })
}

export async function upsertToken(row: IndexedToken): Promise<void> {
  const id = row.token.toLowerCase()
  try {
    await kv.sadd(TOKEN_SET, id)
  } catch (e) {
    console.warn('[arc-indexer] sadd token', summarizeRpcError(e))
  }
  await safeSet(tokenKey(id), row)
}

export async function getToken(token: Address | string): Promise<IndexedToken | null> {
  return safeGet<IndexedToken>(tokenKey(String(token)))
}

/**
 * Throws KvUnavailableError on a failed read. Returning [] here used to make the cycle believe
 * the registry was empty, which both skipped every token's swap catch-up (swapsTokens: 0, tapes
 * silently going stale until a human loaded the page) and re-triggered a full factory reseed —
 * extra KV writes at exactly the moment KV was already failing.
 */
export async function listTokenAddresses(): Promise<string[]> {
  try {
    const members = await kv.smembers(TOKEN_SET)
    return (members as string[]).map((m) => m.toLowerCase())
  } catch (e) {
    console.warn('[arc-indexer] smembers tokens', summarizeRpcError(e))
    throw new KvUnavailableError('smembers tokens', e)
  }
}

export async function listIndexedTokens(): Promise<IndexedToken[]> {
  const ids = await listTokenAddresses()
  if (!ids.length) return []
  const rows = await Promise.all(ids.map((id) => getToken(id)))
  return rows.filter((r): r is IndexedToken => !!r?.token)
}

export async function setVolume(token: Address | string, vol: IndexedVolume): Promise<void> {
  await safeSet(volumeKey(String(token)), vol, 7 * 24 * 3600)
}

export async function getVolume(token: Address | string): Promise<IndexedVolume | null> {
  return safeGet<IndexedVolume>(volumeKey(String(token)))
}

/** Batch volume for catalog enrichment — one mget, not N sequential reads. */
export async function getVolumesMap(
  tokens: string[],
): Promise<Record<string, IndexedVolume>> {
  const out: Record<string, IndexedVolume> = {}
  const ids = Array.from(new Set(tokens.map((t) => t.toLowerCase()).filter(Boolean)))
  if (ids.length === 0) return out
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const vals = (await kv.mget(...chunk.map(volumeKey))) as (IndexedVolume | null)[]
      chunk.forEach((id, j) => {
        const v = vals[j]
        if (v) out[id] = v
      })
    }
  } catch (e) {
    console.warn('[arc-indexer] mget volumes', summarizeRpcError(e))
  }
  return out
}

export async function upsertOtcOffer(row: IndexedOtcOffer): Promise<void> {
  const id = row.offerId.toLowerCase()
  try {
    await kv.sadd(OTC_OFFER_SET, id)
  } catch (e) {
    console.warn('[arc-indexer] sadd otc', summarizeRpcError(e))
  }
  await safeSet(otcOfferKey(id), row)
}

export async function removeOtcOffer(offerId: Hex | string): Promise<void> {
  const id = String(offerId).toLowerCase()
  try {
    await kv.srem(OTC_OFFER_SET, id)
    await kv.del(otcOfferKey(id))
  } catch (e) {
    console.warn('[arc-indexer] del otc', summarizeRpcError(e))
  }
}

export async function listOtcOffers(): Promise<IndexedOtcOffer[]> {
  try {
    const ids = (await kv.smembers(OTC_OFFER_SET)) as string[]
    if (!ids?.length) return []
    const rows = await Promise.all(ids.map((id) => safeGet<IndexedOtcOffer>(otcOfferKey(id))))
    return rows.filter((r): r is IndexedOtcOffer => !!r?.offerId)
  } catch (e) {
    console.warn('[arc-indexer] list otc', summarizeRpcError(e))
    return []
  }
}

/** Throws KvUnavailableError on failure — 0 must mean "empty", never "couldn't read". */
export async function tokenCount(): Promise<number> {
  try {
    return Number(await kv.scard(TOKEN_SET)) || 0
  } catch (e) {
    throw new KvUnavailableError('scard tokens', e)
  }
}

/** Throws KvUnavailableError on failure — see tokenCount. */
export async function otcOfferCount(): Promise<number> {
  try {
    return Number(await kv.scard(OTC_OFFER_SET)) || 0
  } catch (e) {
    throw new KvUnavailableError('scard otc offers', e)
  }
}

/** Reporting helper: count, or null when KV could not answer. */
export async function countOrNull(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

/**
 * Lifetime OTC desk stats (FillSettled count + source USDC volume).
 * Independent of the offer book so a rolling log window cannot zero the homepage.
 */
const OTC_DESK_STATS_KEY = 'arcfun:idx:otc:desk-stats'

export type IndexedOtcDeskStats = {
  settledTrades: number
  /** USDC 6dp (proceeds + fee), decimal string */
  volumeUsdc: string
  /** chainId -> last fully scanned block (inclusive) */
  settledCursor: Record<string, string>
  /** True once every live payment chain has been scanned up to its head. */
  complete: boolean
  updatedAt: number
}

export async function loadOtcDeskStats(): Promise<IndexedOtcDeskStats | null> {
  return safeGet<IndexedOtcDeskStats>(OTC_DESK_STATS_KEY)
}

export async function saveOtcDeskStats(row: IndexedOtcDeskStats): Promise<void> {
  await safeSet(OTC_DESK_STATS_KEY, { ...row, updatedAt: Date.now() })
}

/**
 * Live Arc hard-reserves. Written by POST /api/otc/reserve so a fillOffer that
 * never mines (out of gas, user reject) is still visible and can be released
 * without a Reserved-log scan.
 */
const OTC_RESERVATION_SET = 'arcfun:idx:otc:reservations'
const otcReservationKey = (id: string) => `arcfun:idx:otc:reservation:${id.toLowerCase()}`

export type IndexedOtcReservation = {
  reservationId: Hex
  offerId: Hex
  amount: string
  expiresAt: number
  txHash?: Hex
  createdAt: number
}

export async function upsertOtcReservation(row: IndexedOtcReservation): Promise<void> {
  const id = row.reservationId.toLowerCase()
  try {
    await kv.sadd(OTC_RESERVATION_SET, id)
  } catch (e) {
    console.warn('[arc-indexer] sadd reservation', summarizeRpcError(e))
  }
  await safeSet(otcReservationKey(id), row, 2 * 60 * 60)
}

export async function removeOtcReservation(reservationId: Hex | string): Promise<void> {
  const id = String(reservationId).toLowerCase()
  try {
    await kv.srem(OTC_RESERVATION_SET, id)
    await kv.del(otcReservationKey(id))
  } catch (e) {
    console.warn('[arc-indexer] del reservation', summarizeRpcError(e))
  }
}

export async function listOtcReservations(): Promise<IndexedOtcReservation[]> {
  try {
    const ids = (await kv.smembers(OTC_RESERVATION_SET)) as string[]
    if (!ids?.length) return []
    const rows = await Promise.all(
      ids.map((id) => safeGet<IndexedOtcReservation>(otcReservationKey(id))),
    )
    return rows.filter((r): r is IndexedOtcReservation => !!r?.reservationId)
  } catch (e) {
    console.warn('[arc-indexer] list reservations', summarizeRpcError(e))
    return []
  }
}
