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
}

export async function setPortCollectionMeta(address: string, meta: PortCollectionMeta) {
  const prev = (await kv.get<PortCollectionMeta>(KEY(address))) ?? {}
  await kv.set(KEY(address), { ...prev, ...meta })
}

export async function getPortCollectionMeta(address: string): Promise<PortCollectionMeta | null> {
  try {
    return (await kv.get<PortCollectionMeta>(KEY(address))) ?? null
  } catch {
    return null
  }
}

export async function getPortCollectionMetas(addresses: string[]) {
  const out = new Map<string, PortCollectionMeta>()
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).filter(Boolean)
  if (unique.length === 0) return out
  try {
    const vals = (await kv.mget(...unique.map(KEY))) as (PortCollectionMeta | null)[]
    unique.forEach((a, i) => {
      if (vals[i]) out.set(a, vals[i] as PortCollectionMeta)
    })
  } catch {
    /* kv optional */
  }
  return out
}
