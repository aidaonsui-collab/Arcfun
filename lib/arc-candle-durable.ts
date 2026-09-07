/**
 * Cap which tokens get durable Supabase candle writes (Free-tier cost control).
 *
 * Ranking uses lifetime pad volume (`volumeAll` from the indexer). Env:
 *   CANDLE_DURABLE_MAX_TOKENS — top-N by volumeAll (default 20; 0 = unlimited)
 *   CANDLE_DURABLE_ALWAYS     — CSV of addresses always written (default $EVE)
 *
 * Reads are unchanged — long-tail rows already in Supabase still serve. This only
 * gates new writes via recordTrades1m / backfill.
 */
import type { Address } from 'viem'

/** Default always-write address ($EVE). Kept inline so unit tests need no eve/viem side effects. */
const DEFAULT_ALWAYS_TOKEN = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF'

const DEFAULT_MAX = 20
/** Brief in-process cache so each trade does not re-rank the whole catalog. */
const RANK_CACHE_MS = 60_000

export type CandleDurableConfig = {
  /** 0 = unlimited (every token may write). */
  maxTokens: number
  always: Set<string>
}

export function parseCandleDurableMax(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_MAX
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX
  return Math.floor(n)
}

export function parseCandleDurableAlways(raw: string | undefined): Set<string> {
  const parts =
    raw == null || raw.trim() === ''
      ? [DEFAULT_ALWAYS_TOKEN]
      : raw.split(',').map((s) => s.trim()).filter(Boolean)
  return new Set(parts.map((a) => a.toLowerCase()))
}

export function readCandleDurableConfig(
  env: NodeJS.ProcessEnv = process.env,
): CandleDurableConfig {
  return {
    maxTokens: parseCandleDurableMax(env.CANDLE_DURABLE_MAX_TOKENS),
    always: parseCandleDurableAlways(env.CANDLE_DURABLE_ALWAYS),
  }
}

/**
 * Pure allowlist builder for tests and ranking. When maxTokens === 0, unlimited.
 * Otherwise: top `maxTokens` by volumeAll ∪ always-set (always wins even if not top-N).
 */
export function buildCandleDurableAllowlist(opts: {
  maxTokens: number
  always: Iterable<string>
  /** token address (any case) → lifetime pad volume USD */
  volumes: Record<string, number>
}): { unlimited: boolean; allowed: Set<string> } {
  const always = new Set(
    [...opts.always].map((a) => a.toLowerCase()).filter(Boolean),
  )
  if (opts.maxTokens === 0) {
    return { unlimited: true, allowed: always }
  }
  const volLc: Record<string, number> = {}
  for (const [k, v] of Object.entries(opts.volumes)) {
    const id = k.toLowerCase()
    volLc[id] = Math.max(volLc[id] ?? 0, Number(v) || 0)
  }
  const top = Object.keys(volLc)
    .sort((a, b) => volLc[b]! - volLc[a]!)
    .slice(0, opts.maxTokens)
  return { unlimited: false, allowed: new Set([...always, ...top]) }
}

type CachedAllowlist = {
  at: number
  unlimited: boolean
  allowed: Set<string>
}

let cache: CachedAllowlist | null = null
let inflight: Promise<CachedAllowlist> | null = null

async function rankAllowlist(): Promise<CachedAllowlist> {
  const { maxTokens, always } = readCandleDurableConfig()
  if (maxTokens === 0) {
    return { at: Date.now(), unlimited: true, allowed: always }
  }
  try {
    const { getVolumesMap, listTokenAddresses } = await import('./arc-indexer/store')
    const ids = await listTokenAddresses()
    const vols = await getVolumesMap(ids)
    const volumes: Record<string, number> = {}
    for (const id of ids) {
      volumes[id.toLowerCase()] = vols[id.toLowerCase()]?.volumeAll ?? 0
    }
    // Include always tokens even if they somehow aren't in the indexed set yet.
    for (const a of always) {
      if (volumes[a] == null) volumes[a] = 0
    }
    const built = buildCandleDurableAllowlist({ maxTokens, always, volumes })
    return { at: Date.now(), unlimited: built.unlimited, allowed: built.allowed }
  } catch (e) {
    // Cost-conscious fallback: keep writing always-list only until ranking works again.
    // Prefer a still-fresh/stale cache over dropping to always-only when we have one.
    if (cache) return cache
    console.warn(
      '[arc-candle-durable] rank failed; restricting to CANDLE_DURABLE_ALWAYS',
      e instanceof Error ? e.message : e,
    )
    return { at: Date.now(), unlimited: false, allowed: always }
  }
}

async function getCachedAllowlist(): Promise<CachedAllowlist> {
  const now = Date.now()
  if (cache && now - cache.at < RANK_CACHE_MS) return cache
  if (inflight) return inflight
  inflight = rankAllowlist()
    .then((next) => {
      cache = next
      return next
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Whether durable candle writes are allowed for this token under the current cap. */
export async function isCandleDurableToken(token: Address | string): Promise<boolean> {
  const id = String(token).toLowerCase()
  const { unlimited, allowed } = await getCachedAllowlist()
  if (unlimited) return true
  return allowed.has(id)
}

/** Snapshot of the current allowlist (for backfill logging / filtering). */
export async function getCandleDurableAllowlist(): Promise<{
  unlimited: boolean
  allowed: Set<string>
  maxTokens: number
}> {
  const { maxTokens } = readCandleDurableConfig()
  const snap = await getCachedAllowlist()
  return { unlimited: snap.unlimited, allowed: snap.allowed, maxTokens }
}

/** Test helper — drop the in-process ranking cache. */
export function resetCandleDurableCacheForTests(): void {
  cache = null
  inflight = null
}
