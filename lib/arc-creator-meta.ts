/**
 * Off-chain creator profile fields (display name, bio, avatar, X).
 */
import { kv } from '@vercel/kv'

const KEY = (a: string) => `arcfun:creator:meta:${a.toLowerCase()}`

export type CreatorMeta = {
  displayName?: string
  bio?: string
  avatarUrl?: string
  twitter?: string
  updatedAt?: number
}

const MAX_NAME = 48
const MAX_BIO = 280
const MAX_TWITTER = 32

export function sanitizeCreatorMeta(input: Partial<CreatorMeta>): CreatorMeta {
  const out: CreatorMeta = {}
  if (typeof input.displayName === 'string') {
    const v = input.displayName.trim().slice(0, MAX_NAME)
    if (v) out.displayName = v
    else out.displayName = ''
  }
  if (typeof input.bio === 'string') {
    out.bio = input.bio.trim().slice(0, MAX_BIO)
  }
  if (typeof input.avatarUrl === 'string') {
    const u = input.avatarUrl.trim()
    if (!u) out.avatarUrl = ''
    else if (/^https:\/\/(res\.cloudinary\.com|.*\.cloudinary\.com)\//i.test(u) || /^https:\/\//i.test(u)) {
      out.avatarUrl = u.slice(0, 512)
    }
  }
  if (typeof input.twitter === 'string') {
    let t = input.twitter.trim().replace(/^@/, '')
    t = t.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').split(/[/?#]/)[0] || ''
    t = t.replace(/[^a-zA-Z0-9_]/g, '').slice(0, MAX_TWITTER)
    out.twitter = t
  }
  return out
}

export async function getCreatorMeta(address: string): Promise<CreatorMeta> {
  try {
    return (await kv.get<CreatorMeta>(KEY(address))) ?? {}
  } catch {
    return {}
  }
}

export async function setCreatorMeta(address: string, patch: CreatorMeta): Promise<CreatorMeta> {
  const prev = await getCreatorMeta(address)
  const next: CreatorMeta = { ...prev }
  for (const [k, v] of Object.entries(patch) as [keyof CreatorMeta, string | number | undefined][]) {
    if (v === undefined) continue
    if (v === '') delete next[k]
    else (next as Record<string, unknown>)[k] = v
  }
  next.updatedAt = Date.now()
  await kv.set(KEY(address), next)
  return next
}
