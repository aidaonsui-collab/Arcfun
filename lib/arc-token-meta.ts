/**
 * Off-chain display metadata for Arc Instant tokens, keyed by lowercased address.
 * Mirrors lib/stable-token-meta.ts. Server-only (Vercel KV).
 */
import { kv } from '@vercel/kv'

const KEY = (t: string) => `arc:token:meta:${t.toLowerCase()}`

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

export async function setArcTokenMeta(token: string, meta: ArcTokenMeta): Promise<void> {
  const prev = (await kv.get<ArcTokenMeta>(KEY(token))) ?? {}
  await kv.set(KEY(token), { ...prev, ...meta, instantLaunch: true })
}

export async function getArcTokenMeta(token: string): Promise<ArcTokenMeta | null> {
  return (await kv.get<ArcTokenMeta>(KEY(token))) ?? null
}

export async function getArcTokenMetas(tokens: string[]): Promise<Map<string, ArcTokenMeta>> {
  const out = new Map<string, ArcTokenMeta>()
  const unique = Array.from(new Set(tokens.map((t) => t.toLowerCase()))).filter(Boolean)
  if (unique.length === 0) return out
  try {
    const vals = (await kv.mget(...unique.map(KEY))) as (ArcTokenMeta | null)[]
    unique.forEach((t, i) => {
      if (vals[i]) out.set(t, vals[i] as ArcTokenMeta)
    })
  } catch {
    /* ignore */
  }
  return out
}
