import { kv } from '@vercel/kv'

const KEY = (a: string) => `arcfun:port:meta:${a.toLowerCase()}`

export type PortCollectionMeta = {
  name?: string
  symbol?: string
  imageUrl?: string
  bannerUrl?: string
  description?: string
  twitter?: string
  telegram?: string
  website?: string
  creator?: string
  originToken?: string
}

/**
 * Last-known-good overlay per collection, for the life of a warm serverless instance.
 *
 * Same fix already applied to lib/arc-token-meta.ts (2026-08-21): the reads below used to
 * collapse "KV failed" into "no record", so one failed read stripped a collection's image,
 * banner, description and socials — visually identical to a collection that never registered.
 * The stored record was never lost; only the read failed. A slightly stale overlay is strictly
 * better than blanking a collection's identity.
 *
 * Only narrows the window: a cold start with KV still down has nothing cached.
 */
const lastGood = new Map<string, PortCollectionMeta>()

/** One quick retry — observed KV failures are brief blips, not sustained outages. */
async function kvGetWithRetry<T>(key: string): Promise<T | null> {
  try {
    return (await kv.get<T>(key)) ?? null
  } catch {
    await new Promise((r) => setTimeout(r, 120))
    return (await kv.get<T>(key)) ?? null // second failure propagates to the caller
  }
}

export async function setPortCollectionMeta(address: string, meta: PortCollectionMeta) {
  // A throw here aborts the write entirely — deliberate. Merging onto `{}` after a failed read
  // would wipe whatever was already stored (imageUrl, banner, socials) for this collection.
  const prev = (await kv.get<PortCollectionMeta>(KEY(address))) ?? {}
  const next: PortCollectionMeta = { ...prev }
  for (const [k, v] of Object.entries(meta) as [keyof PortCollectionMeta, string | undefined][]) {
    if (v === undefined) continue
    if (v === '') delete next[k]
    else next[k] = v
  }
  await kv.set(KEY(address), next)
  lastGood.set(address.toLowerCase(), next)
}

export async function getPortCollectionMeta(address: string): Promise<PortCollectionMeta | null> {
  const id = address.toLowerCase()
  try {
    const hit = await kvGetWithRetry<PortCollectionMeta>(KEY(address))
    if (hit) lastGood.set(id, hit)
    // A genuine miss must not evict a good cached copy, nor invent one for a collection that
    // truly has no overlay — serve whatever we last knew.
    return hit ?? lastGood.get(id) ?? null
  } catch {
    // Read unavailable — serve last known good rather than blanking the collection.
    return lastGood.get(id) ?? null
  }
}

export async function getPortCollectionMetas(addresses: string[]) {
  const out = new Map<string, PortCollectionMeta>()
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).filter(Boolean)
  if (unique.length === 0) return out
  try {
    const vals = (await kv.mget(...unique.map(KEY))) as (PortCollectionMeta | null)[]
    unique.forEach((a, i) => {
      const hit = vals[i]
      if (hit) {
        out.set(a, hit)
        lastGood.set(a, hit)
      } else {
        // Miss on this key only — a cached copy is better than dropping the overlay.
        const cached = lastGood.get(a)
        if (cached) out.set(a, cached)
      }
    })
  } catch {
    // Whole mget failed. This feeds the collection grid, so returning an empty map renders every
    // collection stripped of its art and socials at once — serve what we last knew instead.
    unique.forEach((a) => {
      const cached = lastGood.get(a)
      if (cached) out.set(a, cached)
    })
  }
  return out
}
