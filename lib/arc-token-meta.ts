/**
 * Off-chain display metadata for Arc Instant tokens, keyed by lowercased address.
 * Mirrors lib/stable-token-meta.ts. Server-only (Vercel KV).
 */
import { kv } from '@vercel/kv'

/** ArcFun-only prefix — do not share the Robinpad `arc:token:meta:` namespace. */
const KEY = (t: string) => `arcfun:token:meta:${t.toLowerCase()}`

export interface ArcTokenMeta {
  name?: string
  symbol?: string
  imageUrl?: string
  description?: string
  twitter?: string
  telegram?: string
  website?: string
  streamUrl?: string
  creator?: string
  /** Uni V3 pool if known at register time */
  pool?: string
  instantLaunch?: boolean
}

/**
 * Last-known-good metadata per token, held in module scope for the life of a warm serverless
 * instance.
 *
 * Found live 2026-08-21: Upstash reads were failing intermittently (measured ~4 of 6 on
 * /api/arc/indexer/status at the time). Every caller in lib/arc-instant-tokens.ts wraps this
 * module in `.catch(() => null)`, so a single failed read rendered the token with NO pfp, no
 * socials and no description — visually identical to a token that never registered any. The KV
 * record itself was never lost; only the read failed.
 *
 * Metadata is written exactly once, at launch, by POST /api/arc/register — nothing mutates it
 * on a schedule. That makes a slightly stale cached copy strictly better than showing nothing,
 * which is the whole point of this cache.
 *
 * Caveat: this only spans a warm instance. A cold start with KV still down has nothing to fall
 * back on. It narrows the window a lot; it does not replace fixing the underlying KV limit.
 */
const lastGood = new Map<string, ArcTokenMeta>()

/** One quick retry — observed KV failures are brief blips, not sustained outages. */
async function kvGetWithRetry<T>(key: string): Promise<T | null> {
  try {
    return (await kv.get<T>(key)) ?? null
  } catch {
    await new Promise((r) => setTimeout(r, 120))
    return (await kv.get<T>(key)) ?? null // second failure propagates to the caller
  }
}

export async function setArcTokenMeta(token: string, meta: ArcTokenMeta): Promise<void> {
  // If this read throws, the whole call throws and NOTHING is written — deliberate. Writing
  // with `prev = {}` after a failed read would merge partial input over a blank base and wipe
  // whatever was already stored (imageUrl, socials) for this token.
  const prev = (await kv.get<ArcTokenMeta>(KEY(token))) ?? {}
  const next: ArcTokenMeta = { ...prev }
  for (const [k, v] of Object.entries(meta) as [keyof ArcTokenMeta, ArcTokenMeta[keyof ArcTokenMeta]][]) {
    if (v === undefined) continue
    if (v === '') delete next[k]
    else (next as Record<string, unknown>)[k] = v
  }
  next.instantLaunch = true
  await kv.set(KEY(token), next)
  lastGood.set(token.toLowerCase(), next)
}

export async function getArcTokenMeta(token: string): Promise<ArcTokenMeta | null> {
  const id = token.toLowerCase()
  try {
    const hit = await kvGetWithRetry<ArcTokenMeta>(KEY(token))
    if (hit) lastGood.set(id, hit)
    // A genuine miss (no record) must not evict a good cached copy, but it also must not
    // resurrect one for a token that truly has no metadata — return whatever we last knew.
    return hit ?? lastGood.get(id) ?? null
  } catch {
    // Read unavailable — serve last known good rather than blanking the token's identity.
    return lastGood.get(id) ?? null
  }
}

export async function getArcTokenMetas(tokens: string[]): Promise<Map<string, ArcTokenMeta>> {
  const out = new Map<string, ArcTokenMeta>()
  const unique = Array.from(new Set(tokens.map((t) => t.toLowerCase()))).filter(Boolean)
  if (unique.length === 0) return out
  try {
    const vals = (await kv.mget(...unique.map(KEY))) as (ArcTokenMeta | null)[]
    unique.forEach((t, i) => {
      const v = vals[i]
      if (v) {
        out.set(t, v)
        lastGood.set(t, v)
      } else {
        const cached = lastGood.get(t)
        if (cached) out.set(t, cached)
      }
    })
  } catch {
    // Batch read unavailable — fall back to whatever this instance already knows.
    for (const t of unique) {
      const cached = lastGood.get(t)
      if (cached) out.set(t, cached)
    }
  }
  return out
}
