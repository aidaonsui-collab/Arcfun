/**
 * Home catalog snapshot — KV + in-process SWR.
 *
 * `/api/arc/tokens` used to rebuild the whole Instant/Reflection catalog from RPC on every
 * cache miss (~4s measured, >5s when Infura/baracat throttle). The home page is a client
 * fetch after hydration, so that miss is a spinner in All launches.
 *
 * Serve the last good snapshot immediately (memory, then KV). Refresh in the background
 * when the snapshot is older than FRESH_MS. First-ever miss still waits on RPC.
 */
import { after } from 'next/server'
import { kv } from '@vercel/kv'
import type { PoolToken } from './tokens'
import { isHiddenToken } from './tokens'
import { buildArcCatalog } from './arc-instant-tokens'
import { bigintReplacer } from './json-safe'
import { summarizeRpcError } from './rpc-error'

const KV_KEY = 'arcfun:catalog:home:v5'
const FRESH_MS = 20_000
const KV_TTL_SEC = 10 * 60

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

async function readKv(): Promise<CatalogSnapshot | null> {
  try {
    const row = await kv.get<CatalogSnapshot>(KV_KEY)
    if (row?.tokens && Array.isArray(row.tokens) && row.at) return row
  } catch {
    /* local / KV blip */
  }
  return null
}

async function writeKv(snap: CatalogSnapshot): Promise<void> {
  try {
    await kv.set(KV_KEY, snap, { ex: KV_TTL_SEC })
  } catch {
    /* best-effort */
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
    const prev = memory ?? (await readKv())
    // A factory timeout (common after adding the Crucible Instant factory) used
    // to throw and freeze the last snapshot, so a just-launched token stayed off
    // home even though /token/[addr] worked. Keep tokens the rebuild missed.
    if (prev && prev.tokens.length > 0) {
      const byId = new Map<string, PoolToken>()
      for (const t of tokens) {
        const id = (t.coinType || t.poolId || t.id || '').toLowerCase()
        if (id) byId.set(id, t)
      }
      for (const t of prev.tokens) {
        const id = (t.coinType || t.poolId || t.id || '').toLowerCase()
        if (!id || byId.has(id) || isHiddenToken(id)) continue
        byId.set(id, t)
      }
      tokens = [...byId.values()]
    }
    const snap: CatalogSnapshot = cloneJson({ tokens, source, at: Date.now() })
    // An empty rebuild is almost always a failed Instant/RPC pass, not a pad
    // with zero launches. Writing it would wipe the home grid until the next
    // successful read (the same [] vs failure collapse as fetchListings).
    if (snap.tokens.length === 0 && prev && prev.tokens.length > 0) {
      console.warn('[arc-catalog] empty rebuild, keeping last-known-good', prev.tokens.length)
      return prev
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

export async function getArcHomeCatalog(): Promise<CatalogSnapshot> {
  const snap = memory ?? (await readKv())
  if (snap) {
    memory = snap
    if (Date.now() - snap.at > FRESH_MS) scheduleRefresh()
    return snap
  }
  return rebuild()
}

/** KV/memory lookup only — never kicks a catalog rebuild. Token pages and the cheap
 *  `/api/arc/[token]` path use this so first HTML does not wait on Instant RPC. */
export async function getArcCatalogToken(address: string): Promise<PoolToken | null> {
  const needle = (address || '').toLowerCase()
  if (!needle) return null
  const snap = memory ?? (await readKv())
  if (!snap?.tokens?.length) return null
  return (
    snap.tokens.find((t) =>
      [t.coinType, t.poolId, t.id].some((v) => (v || '').toLowerCase() === needle),
    ) ?? null
  )
}

export async function invalidateArcHomeCatalog(): Promise<void> {
  memory = null
  try {
    await kv.del(KV_KEY)
  } catch {
    /* best-effort */
  }
}
