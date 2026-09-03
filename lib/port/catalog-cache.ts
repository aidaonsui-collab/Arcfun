/**
 * Studio collection snapshot — KV + in-process SWR.
 *
 * `/studio/eve` is a slug lookup over listCollections(). That used to rebuild from
 * the NFT factory on every request. When Instant/public RPC timed out it returned
 * [] and the slug 404'd even though arcfun:port:meta / items were intact.
 *
 * Serve last-good immediately. Never persist an empty rebuild.
 */
import { after } from 'next/server'
import { kv } from '@vercel/kv'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { bigintReplacer } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'
import { getPortCollectionMeta, getPortCollectionMetas } from './meta'
import { getPortItems } from './item-meta'
import { withPublicSlugs } from './path'
import type { Collection } from './types'
import {
  collectionFromOverlay,
  isUsablePortSnapshot,
  matchPortCollection,
} from './catalog-from-overlay'

export { collectionFromOverlay, isUsablePortSnapshot, matchPortCollection } from './catalog-from-overlay'

const KV_KEY = 'arcfun:port:catalog:v1'
const SET_KEY = 'arcfun:port:collections'
const FRESH_MS = 20_000
const KV_TTL_SEC = 24 * 60 * 60

/**
 * The only Studio collection registered to date. KV overlay is keyed by this
 * address (CollectionCreated block 17155529). Used only to seed the set when
 * SCAN is unavailable and register ran before we started sadd'ing.
 */
const EVE_COLLECTION = '0xB5dE5615Cb49AcC3E3338B02F34560F7d3fDB9E8'

export type PortCatalogSnapshot = {
  collections: Collection[]
  at: number
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, bigintReplacer)) as T
}

let memory: PortCatalogSnapshot | null = null
let inflight: Promise<PortCatalogSnapshot> | null = null

async function readKv(): Promise<PortCatalogSnapshot | null> {
  try {
    const row = await kv.get<PortCatalogSnapshot>(KV_KEY)
    if (isUsablePortSnapshot(row)) return row
  } catch {
    /* blip */
  }
  return null
}

async function writeKv(snap: PortCatalogSnapshot): Promise<void> {
  try {
    await kv.set(KV_KEY, snap, { ex: KV_TTL_SEC })
  } catch {
    /* best-effort */
  }
}

async function registeredAddresses(): Promise<string[]> {
  try {
    const members = (await kv.smembers(SET_KEY)) as string[]
    const ids = (members || []).map((m) => m.toLowerCase()).filter((a) => isPlausibleEvmAddress(a))
    if (ids.length) return ids
  } catch {
    /* fall through to seed */
  }
  const eve = EVE_COLLECTION.toLowerCase()
  const meta = await getPortCollectionMeta(eve).catch(() => null)
  if (meta?.name) {
    try {
      await kv.sadd(SET_KEY, eve)
    } catch {
      /* ignore */
    }
    return [eve]
  }
  return []
}

export async function rememberPortCollection(address: string): Promise<void> {
  const id = address.toLowerCase()
  if (!isPlausibleEvmAddress(id)) return
  try {
    await kv.sadd(SET_KEY, id)
  } catch {
    /* best-effort */
  }
}

async function fromRegistered(): Promise<Collection[]> {
  const ids = await registeredAddresses()
  if (!ids.length) return []
  const metas = await getPortCollectionMetas(ids)
  const rows: Collection[] = []
  for (const id of ids) {
    const store = await getPortItems(id).catch(() => ({ items: {} as Record<string, never> }))
    const itemCount = Object.keys(store.items || {}).length
    rows.push(collectionFromOverlay(id, metas.get(id), null, itemCount))
  }
  return withPublicSlugs(rows)
}

async function rebuild(): Promise<PortCatalogSnapshot> {
  if (inflight) return inflight
  inflight = (async () => {
    const { fetchPortCollectionsLive } = await import('./catalog')
    let collections: Collection[] = []
    try {
      collections = await fetchPortCollectionsLive()
    } catch (e) {
      console.warn('[port-catalog] live', summarizeRpcError(e))
    }
    const prev = isUsablePortSnapshot(memory) ? memory : await readKv()
    if (collections.length === 0) {
      const registered = await fromRegistered()
      if (registered.length) collections = registered
    }
    if (prev && prev.collections.length > 0) {
      const byId = new Map<string, Collection>()
      for (const c of collections) byId.set(c.address.toLowerCase(), c)
      for (const c of prev.collections) {
        const id = c.address.toLowerCase()
        if (!byId.has(id)) byId.set(id, c)
      }
      collections = withPublicSlugs([...byId.values()])
    }
    const snap: PortCatalogSnapshot = cloneJson({ collections, at: Date.now() })
    if (snap.collections.length === 0) {
      if (prev) {
        console.warn('[port-catalog] empty rebuild, keeping last-known-good', prev.collections.length)
        return prev
      }
      console.warn('[port-catalog] empty rebuild, not persisting')
      return snap
    }
    memory = snap
    await writeKv(snap)
    for (const c of snap.collections) await rememberPortCollection(c.address)
    return snap
  })().finally(() => {
    inflight = null
  })
  return inflight
}

function scheduleRefresh(): void {
  if (inflight) return
  const run = () => {
    void rebuild().catch((e) => console.warn('[port-catalog] refresh', summarizeRpcError(e)))
  }
  try {
    after(run)
  } catch {
    run()
  }
}

export async function getPortHomeCatalog(): Promise<PortCatalogSnapshot> {
  const snap = isUsablePortSnapshot(memory) ? memory : await readKv()
  if (snap && snap.collections.length > 0) {
    memory = snap
    if (Date.now() - snap.at > FRESH_MS) scheduleRefresh()
    return snap
  }
  const registered = await fromRegistered()
  if (registered.length > 0) {
    const idx: PortCatalogSnapshot = cloneJson({ collections: registered, at: Date.now() })
    memory = idx
    await writeKv(idx)
    scheduleRefresh()
    return idx
  }
  return rebuild()
}

export async function upsertPortCatalogCollection(row: Collection): Promise<void> {
  if (!row.address) return
  await rememberPortCollection(row.address)
  const snap = isUsablePortSnapshot(memory) ? memory : await readKv()
  const collections = snap?.collections ? [...snap.collections] : []
  const id = row.address.toLowerCase()
  const i = collections.findIndex((c) => c.address.toLowerCase() === id)
  if (i >= 0) collections[i] = { ...collections[i], ...row }
  else collections.unshift(row)
  const next: PortCatalogSnapshot = cloneJson({
    collections: withPublicSlugs(collections),
    at: Date.now(),
  })
  memory = next
  await writeKv(next)
}

export async function getPortCatalogCollection(id: string): Promise<Collection | null> {
  const snap = await getPortHomeCatalog()
  return matchPortCollection(snap.collections, id) ?? null
}
