/**
 * Server tweet fetch for Blitz launch. Paste-URL uses FixTweet (no key).
 * Live watch uses X API v2 when X_BEARER_TOKEN / TWITTER_BEARER_TOKEN is set.
 */
import { kv } from '@vercel/kv'
import { draftFromTweet, parseTweetUrl, sanitizeHandle, type BlitzTweet } from './arc-blitz'
import { firstTweetPhotoFromKeys, tweetStatusUrl } from './arc-blitz-image'

const FX = 'https://api.fxtwitter.com'
const X_API = 'https://api.twitter.com/2'
const FETCH_MS = 8_000

const MEDIA_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com', 'ton.twimg.com'])

function bearer(): string {
  return (process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '').trim()
}

export function blitzWatchLive(): boolean {
  return bearer().length > 20
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), FETCH_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ArcfunBlitz/1.0', ...(headers || {}) },
      signal: ac.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

function firstPhoto(media: unknown): string | null {
  if (!media || typeof media !== 'object') return null
  const m = media as { photos?: { url?: string }[]; all?: { type?: string; url?: string }[] }
  const photo = m.photos?.[0]?.url || m.all?.find((x) => x.type === 'photo')?.url
  return typeof photo === 'string' && photo.startsWith('https://') ? photo : null
}

function bumpAvatar(url: string): string {
  return url.replace(/_normal\.(jpg|png|webp)$/i, '_400x400.$1')
}

type FxTweet = {
  id?: string
  url?: string
  text?: string
  created_timestamp?: number
  author?: { screen_name?: string; name?: string; avatar_url?: string }
  media?: unknown
  quote?: { media?: unknown }
  replying_to?: string
  replying_to_status?: string
}

function fromFx(raw: FxTweet): BlitzTweet | null {
  const id = String(raw.id || '')
  const handle = sanitizeHandle(raw.author?.screen_name || '')
  if (!id || !handle) return null
  // Token art is tweet / quoted media only. Never the author's X pfp.
  const image = firstPhoto(raw.media) || firstPhoto(raw.quote?.media)
  return {
    id,
    url: raw.url || `https://x.com/${handle}/status/${id}`,
    text: String(raw.text || '').slice(0, 2000),
    createdAt: Number(raw.created_timestamp) || Math.floor(Date.now() / 1000),
    handle,
    displayName: String(raw.author?.name || handle),
    avatarUrl: raw.author?.avatar_url ? bumpAvatar(raw.author.avatar_url) : '',
    imageUrl: image,
  }
}

export async function fetchTweetByUrl(raw: string): Promise<BlitzTweet> {
  const parsed = parseTweetUrl(raw)
  if (!parsed) throw new Error('Paste an x.com/status/… URL')
  const path = parsed.handle
    ? `${encodeURIComponent(parsed.handle)}/status/${encodeURIComponent(parsed.id)}`
    : `status/${encodeURIComponent(parsed.id)}`
  const body = (await getJson(`${FX}/${path}`)) as { tweet?: FxTweet; code?: number }
  const tweet = fromFx(body.tweet || {})
  if (!tweet) throw new Error('Tweet not found')
  const parentId = String(body.tweet?.replying_to_status || '')
  if (/^\d{10,22}$/.test(parentId)) {
    const parentHandle = sanitizeHandle(body.tweet?.replying_to || '')
    tweet.sourceHandle = parentHandle || null
    tweet.sourceUrl = tweetStatusUrl(parentHandle, parentId)
    if (!tweet.imageUrl) {
      try {
        const parent = (await getJson(`${FX}/status/${encodeURIComponent(parentId)}`)) as { tweet?: FxTweet }
        tweet.imageUrl = firstPhoto(parent.tweet?.media) || firstPhoto(parent.tweet?.quote?.media)
      } catch {
        /* parent media optional */
      }
    }
  }
  return tweet
}

type XUser = { id: string; username: string; name: string; profile_image_url?: string }
type XMedia = { media_key: string; type: string; url?: string; preview_image_url?: string }
type XTweet = {
  id: string
  text: string
  created_at?: string
  author_id?: string
  attachments?: { media_keys?: string[] }
}

async function xGet(path: string): Promise<unknown> {
  const token = bearer()
  if (!token) throw new Error('X API is not configured')
  return getJson(`${X_API}${path}`, { Authorization: `Bearer ${token}` })
}

async function xUser(handle: string): Promise<XUser> {
  const h = sanitizeHandle(handle)
  const cacheKey = `arcfun:blitz:xuser:${h.toLowerCase()}`
  try {
    const hit = await kv.get<XUser>(cacheKey)
    if (hit?.id) return hit
  } catch {
    /* kv down */
  }
  const body = (await xGet(
    `/users/by/username/${encodeURIComponent(h)}?user.fields=profile_image_url,name,username`,
  )) as { data?: XUser }
  if (!body.data?.id) throw new Error(`No X user @${h}`)
  try {
    await kv.set(cacheKey, body.data, { ex: 86_400 })
  } catch {
    /* ignore */
  }
  return body.data
}

function fromX(
  tw: XTweet,
  user: XUser,
  mediaByKey: Map<string, XMedia>,
): BlitzTweet {
  const image = firstTweetPhotoFromKeys(tw.attachments?.media_keys, mediaByKey)
  const avatar = user.profile_image_url ? bumpAvatar(user.profile_image_url) : ''
  const createdAt = tw.created_at ? Math.floor(new Date(tw.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000)
  return {
    id: tw.id,
    url: `https://x.com/${user.username}/status/${tw.id}`,
    text: tw.text || '',
    createdAt,
    handle: user.username,
    displayName: user.name || user.username,
    avatarUrl: avatar,
    imageUrl: image,
  }
}

export async function fetchHandleFeed(handle: string, max = 8): Promise<BlitzTweet[]> {
  const h = sanitizeHandle(handle)
  if (!h) return []
  const cacheKey = `arcfun:blitz:feed:${h.toLowerCase()}`
  try {
    const hit = await kv.get<BlitzTweet[]>(cacheKey)
    if (Array.isArray(hit) && hit.length) return hit.slice(0, max)
  } catch {
    /* miss */
  }

  if (!blitzWatchLive()) return []

  const user = await xUser(h)
  const n = Math.min(10, Math.max(5, max))
  const qs = new URLSearchParams({
    max_results: String(n),
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,attachments,text',
    expansions: 'attachments.media_keys',
    'media.fields': 'url,preview_image_url,type',
  })
  const body = (await xGet(`/users/${user.id}/tweets?${qs}`)) as {
    data?: XTweet[]
    includes?: { media?: XMedia[] }
  }
  const mediaByKey = new Map((body.includes?.media || []).map((m) => [m.media_key, m]))
  const tweets = (body.data || []).map((tw) => fromX(tw, user, mediaByKey)).filter((t) => t.id)
  try {
    if (tweets.length) await kv.set(cacheKey, tweets, { ex: 20 })
  } catch {
    /* ignore */
  }
  return tweets.slice(0, max)
}

export async function fetchWatchFeed(handles: string[]): Promise<{
  tweets: BlitzTweet[]
  live: boolean
}> {
  const live = blitzWatchLive()
  if (!live) return { tweets: [], live: false }
  const unique = Array.from(new Set(handles.map(sanitizeHandle).filter(Boolean))).slice(0, 8)
  const rows = await Promise.all(
    unique.map(async (h) => {
      try {
        return await fetchHandleFeed(h, 5)
      } catch {
        return [] as BlitzTweet[]
      }
    }),
  )
  const tweets = rows
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 24)
  return { tweets, live: true }
}

export function allowedMediaUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    if (!MEDIA_HOSTS.has(host)) return null
    if (u.username || u.password) return null
    return u.href
  } catch {
    return null
  }
}

export { draftFromTweet }
