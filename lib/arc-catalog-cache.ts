/**
 * Home catalog snapshot — KV + in-process SWR.
 *
 * `/api/arc/tokens` used to rebuild the whole Instant/Reflection catalog from RPC on every
 * cache miss (~4s measured, >5s when Infura/baracat throttle). The home page is a client
 * fetch after hydration, so that miss is a spinner in All launches.
 *
 * Serve the last good snapshot immediately (memory, then KV). Refresh in the background
 * when the snapshot is older than FRESH_MS. An empty snapshot is treated as a miss and
 * filled from the indexer so Instant RPC timeouts cannot blank the home grid.
 */
import { after } from 'next/server'
import { kv } from '@vercel/kv'
import type { PoolToken } from './tokens'
import { isHiddenToken } from './tokens'
import { buildArcCatalog, sanitizePoolTokenSpot } from './arc-instant-tokens'
import { applyListingMeta } from './arc-listing-overlay'
import { getArcTokenMeta, getArcTokenMetas } from './arc-token-meta'
import {
  catalogId,
  getIndexedPoolToken,
  isUsableCatalogSnapshot,
  mergeCatalogTokens,
  poolTokensFromIndexed,
} from './arc-catalog-from-index'
import { bigintReplacer } from './json-safe'
import { summarizeRpcError } from './rpc-error'

/** v6: drop v5 snapshots that stored AMG's 6dp-as-18 print (FDV 7e15). */
const KV_KEY = 'arcfun:catalog:home:v6'
const FRESH_MS = 20_000
/** Last-good home grid. 10 minutes was short enough for an empty Instant
 *  timeout to expire a real snapshot and latch `tokens: []`. */
const KV_TTL_SEC = 24 * 60 * 60

export type CatalogSnapshot = {
  tokens: PoolToken[]
  source: string
  at: number
}

export const CATALOG_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=300',
  'CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=300',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=300',
}

let memory: CatalogSnapshot | null = null
let inflight: Promise<CatalogSnapshot> | null = null

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, bigintReplacer)) as T
}

function sanitizeSnapshot(snap: CatalogSnapshot): CatalogSnapshot {
  return {
    ...snap,
    tokens: snap.tokens.map((t) => sanitizePoolTokenSpot(t)),
  }
}

async function readKv(): Promise<CatalogSnapshot | null> {
  try {
    const row = await kv.get<CatalogSnapshot>(KV_KEY)
    // Empty `tokens: []` is a failed Instant pass that got persisted, not a
    // pad with zero launches. Treat it as a miss so indexer fill can run.
    if (isUsableCatalogSnapshot(row)) return sanitizeSnapshot(row)
  } catch {
    /* local / KV blip */
  }
  return null
}

async function writeKv(snap: CatalogSnapshot): Promise<void> {
  try {
    await kv.set(KV_KEY, sanitizeSnapshot(snap), { ex: KV_TTL_SEC })
  } catch {
    /* best-effort */
  }
}

async function fromIndexer(): Promise<CatalogSnapshot | null> {
  try {
    const tokens = await poolTokensFromIndexed()
    if (!tokens.length) return null
    return cloneJson({ tokens, source: 'arc-idx', at: Date.now() })
  } catch (e) {
    console.warn('[arc-catalog] indexer fill', summarizeRpcError(e))
    return null
  }
}

async function rebuild(): Promise<CatalogSnapshot> {
  if (inflight) return inflight
  inflight = (async () => {
    let { tokens, source } = await buildArcCatalog()
    tokens = tokens.filter((t) => !isHiddenToken(t.coinType ?? t.poolId))
    try {
      const { enrichTokensWithIndexVolume } = await import('@/lib/arc-indexer/run')
      tokens = await enrichTokensWithIndexVolume(tokens)
      source = `${source}+idx`
      const { seedLifetimeVolume } = await import('@/lib/arc-indexer/volume')
      tokens = await seedLifetimeVolume(tokens, 3)
    } catch {
      /* indexer optional */
    }
    const prev = isUsableCatalogSnapshot(memory) ? memory : await readKv()
    // A factory timeout (common after adding the Crucible Instant factory) used
    // to throw and freeze the last snapshot, so a just-launched token stayed off
    // home even though /token/[addr] worked. Keep tokens the rebuild missed.
    if (prev && prev.tokens.length > 0) {
      tokens = mergeCatalogTokens(tokens, prev.tokens.filter((t) => !isHiddenToken(catalogId(t))))
    }
    if (tokens.length === 0) {
      const idx = await fromIndexer()
      if (idx) {
        tokens = idx.tokens
        source = idx.source
      }
    } else {
      const idx = await fromIndexer()
      if (idx?.tokens.length) tokens = mergeCatalogTokens(tokens, idx.tokens)
    }
    const snap: CatalogSnapshot = sanitizeSnapshot(
      cloneJson({ tokens, source, at: Date.now() }),
    )
    // An empty rebuild is almost always a failed Instant/RPC pass, not a pad
    // with zero launches. Writing it would wipe the home grid until the next
    // successful read (the same [] vs failure collapse as fetchListings).
    if (snap.tokens.length === 0) {
      if (prev && prev.tokens.length > 0) {
        console.warn('[arc-catalog] empty rebuild, keeping last-known-good', prev.tokens.length)
        return sanitizeSnapshot(prev)
      }
      console.warn('[arc-catalog] empty rebuild, not persisting')
      return snap
    }
    memory = snap
    await writeKv(snap)
    return snap
  })().finally(() => {
    inflight = null
  })
  return inflight
}

function scheduleRefresh(): void {
  if (inflight) return
  const run = () => {
    void rebuild().catch((e) => console.warn('[arc-catalog] refresh', summarizeRpcError(e)))
  }
  try {
    after(run)
  } catch {
    run()
  }
}

async function overlaySnapshot(snap: CatalogSnapshot): Promise<CatalogSnapshot> {
  const clean = sanitizeSnapshot(snap)
  try {
    const metas = await getArcTokenMetas(clean.tokens.map((t) => t.coinType || t.poolId || t.id))
    if (metas.size === 0) return clean
    return {
      ...clean,
      tokens: clean.tokens.map((t) => {
        const id = (t.coinType || t.poolId || t.id || '').toLowerCase()
        return sanitizePoolTokenSpot(applyListingMeta(t, metas.get(id) ?? null))
      }),
    }
  } catch {
    return clean
  }
}

export async function getArcHomeCatalog(): Promise<CatalogSnapshot> {
  const snap = isUsableCatalogSnapshot(memory) ? sanitizeSnapshot(memory) : await readKv()
  if (snap && snap.tokens.length > 0) {
    memory = snap
    if (Date.now() - snap.at > FRESH_MS) scheduleRefresh()
    return overlaySnapshot(snap)
  }
  // No last-good snapshot (or a persisted empty one). Paint from the indexer
  // immediately — Instant factory RPC is what emptied the grid — then refresh.
  const idx = await fromIndexer()
  if (idx && idx.tokens.length > 0) {
    memory = sanitizeSnapshot(idx)
    await writeKv(memory)
    scheduleRefresh()
    return overlaySnapshot(memory)
  }
  return overlaySnapshot(await rebuild())
}

/** KV/memory lookup only — never kicks a catalog rebuild. Token pages and the cheap
 *  `/api/arc/[token]` path use this so first HTML does not wait on Instant RPC. */
export async function getArcCatalogToken(address: string): Promise<PoolToken | null> {
  const needle = (address || '').toLowerCase()
  if (!needle || isHiddenToken(needle)) return null
  const snap = isUsableCatalogSnapshot(memory) ? memory : await readKv()
  const hit =
    snap?.tokens.find((t) =>
      [t.coinType, t.poolId, t.id].some((v) => (v || '').toLowerCase() === needle),
    ) ?? null
  if (hit) {
    const meta = await getArcTokenMeta(needle).catch(() => null)
    return sanitizePoolTokenSpot(applyListingMeta(hit, meta))
  }
  const indexed = await getIndexedPoolToken(needle).catch(() => null)
  if (!indexed) return null
  const meta = await getArcTokenMeta(needle).catch(() => null)
  return sanitizePoolTokenSpot(applyListingMeta(indexed, meta))
}

/**
 * Stamp one token into the home snapshot (new launch or listing edit).
 * Deleting the whole catalog used to hide a just-launched token until the 2-minute indexer cron.
 */
export async function upsertArcCatalogToken(row: PoolToken): Promise<void> {
  const id = catalogId(row)
  if (!id || isHiddenToken(id)) return
  const snap = isUsableCatalogSnapshot(memory) ? memory : await readKv()
  const tokens = snap?.tokens ? [...snap.tokens] : []
  const idx = tokens.findIndex((t) => catalogId(t) === id)
  if (idx >= 0) tokens[idx] = { ...tokens[idx], ...row }
  else tokens.unshift(row)
  const next: CatalogSnapshot = sanitizeSnapshot(
    cloneJson({
      tokens,
      source: snap?.source || 'arc-instant',
      at: Date.now(),
    }),
  )
  memory = next
  await writeKv(next)
}

export async function patchArcCatalogListing(
  address: string,
  patch: Partial<Pick<PoolToken, 'imageUrl' | 'logoUrl' | 'twitter' | 'telegram' | 'website' | 'description' | 'streamUrl'>>,
): Promise<void> {
  const needle = address.toLowerCase()
  if (!needle) return
  const snap = memory ?? (await readKv())
  if (!snap?.tokens?.length) return
  const idx = snap.tokens.findIndex((t) => catalogId(t) === needle)
  if (idx < 0) return
  const prev = snap.tokens[idx]
  const imageUrl = patch.imageUrl !== undefined ? patch.imageUrl : prev.imageUrl
  const nextRow: PoolToken = {
    ...prev,
    ...patch,
    imageUrl,
    logoUrl: patch.logoUrl ?? patch.imageUrl ?? prev.logoUrl,
  }
  const tokens = [...snap.tokens]
  tokens[idx] = nextRow
  const next: CatalogSnapshot = sanitizeSnapshot(cloneJson({ ...snap, tokens, at: Date.now() }))
  memory = next
  await writeKv(next)
}

export async function invalidateArcHomeCatalog(): Promise<void> {
  memory = null
  try {
    await kv.del(KV_KEY)
  } catch {
    /* best-effort */
  }
}
