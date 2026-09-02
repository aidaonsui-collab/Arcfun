/**
 * Blitz launch — tweet → Instant TOKEN/USDC create.
 * Unwired: UI hidden, /api/arc/blitz/* 404, Vercel cron removed.
 * Same factory and pair as /create. This is only the fill path.
 */
export function blitzLaunchEnabled(): boolean {
  return false
}
import { blitzTokenImageUrl } from './arc-blitz-image'

export const BLITZ_WATCH_KEY = 'arcfun_blitz_watch'
export const BLITZ_SEEN_KEY = 'arcfun_blitz_seen'
export const BLITZ_ALERTS_KEY = 'arcfun_blitz_alerts'

export const DEFAULT_WATCH = ['jerallaire', 'circle', 'arc'] as const

export type BlitzTweet = {
  id: string
  url: string
  text: string
  createdAt: number
  handle: string
  displayName: string
  avatarUrl: string
  imageUrl: string | null
  /** Parent tweet when this is a reply; used as token art + social. */
  sourceUrl?: string | null
  sourceHandle?: string | null
}

export type BlitzPrefill = {
  name: string
  symbol: string
  description: string
  twitter: string
  website: string
  imageUrl?: string
  tweetUrl?: string
  handle?: string
}

const TWEET_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'www.x.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
])

/** Snowflake id from an x.com / twitter.com / fx status URL. */
export function parseTweetUrl(raw: string): { handle: string; id: string } | null {
  const t = raw.trim()
  if (!t) return null
  const idOnly = t.match(/^\d{10,22}$/)
  if (idOnly) return { handle: '', id: idOnly[0] }
  try {
    const u = new URL(t.startsWith('http') ? t : `https://${t}`)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    if (!TWEET_HOSTS.has(u.hostname.toLowerCase()) && !TWEET_HOSTS.has(host)) return null
    const parts = u.pathname.split('/').filter(Boolean)
    const statusAt = parts.findIndex((p) => p.toLowerCase() === 'status')
    if (statusAt >= 0 && parts[statusAt + 1] && /^\d{10,22}$/.test(parts[statusAt + 1].split('?')[0])) {
      const id = parts[statusAt + 1].split(/[?#]/)[0]
      const handle = (parts[0] && parts[0].toLowerCase() !== 'i' && parts[0].toLowerCase() !== 'status'
        ? parts[0]
        : ''
      ).replace(/^@/, '')
      return { handle, id }
    }
  } catch {
    /* not a URL */
  }
  return null
}

export function sanitizeHandle(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 32)
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'for', 'on', 'in', 'with', 'this', 'that',
  'just', 'from', 'soon', 'new', 'our', 'we', 'you', 'it', 'be', 'as', 'at', 'or', 'if',
])

export function draftFromTweet(t: BlitzTweet): BlitzPrefill {
  const clean = t.text.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim()
  const cashtag = [...clean.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g)].map((m) => m[1].toUpperCase())[0]
  let symbol = cashtag || ''
  if (!symbol) {
    const camel = clean.match(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/)
    if (camel) symbol = camel[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  }
  if (!symbol) {
    const words = clean
      .split(/[^A-Za-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()))
    symbol = words.slice(0, 2).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  }
  if (!symbol || symbol.length < 2) {
    symbol = t.handle.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'TOKEN'
  }
  const name = (clean.split(/[.!?\n]/)[0] || clean).trim().slice(0, 48) || t.displayName || t.handle
  const origin = t.sourceUrl || t.url
  const description = [t.text.trim(), origin].filter(Boolean).join('\n\n').slice(0, 500)
  return {
    name,
    symbol,
    description,
    twitter: origin || t.handle,
    website: origin,
    imageUrl: blitzTokenImageUrl(t.imageUrl),
    tweetUrl: origin || t.url,
    handle: t.sourceHandle || t.handle,
  }
}

export function loadWatchList(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BLITZ_WATCH_KEY) : null
    if (!raw) return [...DEFAULT_WATCH]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_WATCH]
    const out = parsed.map((h) => sanitizeHandle(String(h))).filter(Boolean)
    return out.length ? Array.from(new Set(out)) : [...DEFAULT_WATCH]
  } catch {
    return [...DEFAULT_WATCH]
  }
}

export function saveWatchList(handles: string[]): string[] {
  const out = Array.from(new Set(handles.map(sanitizeHandle).filter(Boolean))).slice(0, 12)
  try {
    localStorage.setItem(BLITZ_WATCH_KEY, JSON.stringify(out))
  } catch {
    /* private mode */
  }
  return out
}

export function loadSeenIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BLITZ_SEEN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

export function saveSeenIds(map: Record<string, string>): void {
  try {
    localStorage.setItem(BLITZ_SEEN_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(BLITZ_ALERTS_KEY) === '1'
  } catch {
    return false
  }
}

export function setAlertsEnabled(on: boolean): void {
  try {
    localStorage.setItem(BLITZ_ALERTS_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function prefillQuery(p: BlitzPrefill): string {
  const q = new URLSearchParams()
  q.set('blitz', '1')
  if (p.name) q.set('name', p.name)
  if (p.symbol) q.set('symbol', p.symbol)
  if (p.description) q.set('description', p.description)
  if (p.twitter) q.set('twitter', p.twitter)
  if (p.website) q.set('website', p.website)
  if (p.imageUrl) q.set('image', p.imageUrl)
  if (p.tweetUrl) q.set('tweet', p.tweetUrl)
  return q.toString()
}

/** Twitter snowflakes are decimal ids; string compare is only safe at equal length. */
export function tweetIdNewer(a: string, b: string): boolean {
  if (!b) return true
  if (a.length !== b.length) return a.length > b.length
  return a > b
}

export function prefillFromSearch(sp: URLSearchParams): BlitzPrefill | null {
  if (sp.get('blitz') !== '1' && !sp.get('tweet') && !sp.get('name')) return null
  const name = (sp.get('name') || '').trim().slice(0, 64)
  const symbol = (sp.get('symbol') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  if (!name && !symbol && !sp.get('tweet')) return null
  return {
    name,
    symbol,
    description: (sp.get('description') || '').trim().slice(0, 500),
    twitter: (sp.get('twitter') || '').trim().slice(0, 80),
    website: (sp.get('website') || sp.get('tweet') || '').trim().slice(0, 200),
    imageUrl: (sp.get('image') || '').trim() || undefined,
    tweetUrl: (sp.get('tweet') || '').trim() || undefined,
    handle: (sp.get('twitter') || '').replace(/^@/, '').trim() || undefined,
  }
}
