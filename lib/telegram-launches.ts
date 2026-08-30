/**
 * Post newly catalogued Instant launches to Telegram.
 *
 * First empty KV-set tick seeds every current address and sends nothing, so the
 * live catalog is not dumped into the channel. Later ticks post at most 5 new
 * (non-hidden) tokens, oldest `createdAt` first. Addresses are marked posted
 * only after a successful Telegram send.
 *
 * Bot token is never logged.
 */
import { kv } from '@vercel/kv'
import { getArcHomeCatalog } from '@/lib/arc-catalog-cache'
import { isHiddenToken, type PoolToken } from '@/lib/tokens'

const POSTED_KEY = 'arcfun:telegram:posted-launches'
const MAX_PER_TICK = 5
const TOKEN_PAGE = 'https://arcfun.co/token'

export type TelegramLaunchTickResult = {
  ok: boolean
  skipped?: string
  seeded: number
  posted: number
  errors: string[]
  addresses: string[]
}

function identity(t: PoolToken): string {
  return (t.coinType || t.poolId || t.id || '').toLowerCase()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortAddr(addr: string): string {
  const a = addr.trim()
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function twitterHandle(raw: string): string | null {
  const t = (raw || '').trim()
  if (!t) return null
  const url = t.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/(?:@)?([A-Za-z0-9_]{1,15})/i)
  if (url?.[1] && url[1].toLowerCase() !== 'intent' && url[1].toLowerCase() !== 'share') {
    return url[1]
  }
  const handle = t.replace(/^@/, '').split(/[/?#]/)[0]
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) return handle
  return null
}

function formatMc(mc: number): string {
  if (!(mc > 0) || !Number.isFinite(mc)) return ''
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(1)}k`
  return `$${mc >= 100 ? mc.toFixed(0) : mc.toFixed(2)}`
}

function httpsImage(t: PoolToken): string | null {
  for (const u of [t.imageUrl, t.logoUrl]) {
    if (typeof u === 'string' && u.startsWith('https://')) return u
  }
  return null
}

function caption(t: PoolToken, address: string): string {
  const symbol = escapeHtml(t.symbol || '')
  const name = escapeHtml(t.name || '')
  const creatorRaw = t.creator || t.creatorFull || ''
  const lines = ['<b>New Instant launch</b>', `$${symbol} — ${name}`]
  if (typeof t.marketCap === 'number' && t.marketCap > 0) {
    lines.push(`MC ${formatMc(t.marketCap)}`)
  }
  if (creatorRaw) {
    lines.push(`Creator <code>${escapeHtml(shortAddr(creatorRaw))}</code>`)
  }
  const handle = twitterHandle(t.twitter || '')
  if (handle) lines.push(`X @${escapeHtml(handle)}`)
  lines.push(`<a href="${TOKEN_PAGE}/${encodeURIComponent(address)}">Open on Arcfun</a>`)
  return lines.join('\n')
}

type TgOk = { ok: true }
type TgFail = { ok: false; error: string }

async function telegramCall(
  method: 'sendPhoto' | 'sendMessage',
  token: string,
  body: Record<string, unknown>,
): Promise<TgOk | TgFail> {
  const url = `https://api.telegram.org/bot${token}/${method}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null
    if (res.ok && json?.ok) return { ok: true }
    return { ok: false, error: json?.description || `telegram ${method} HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function sendLaunch(
  token: string,
  chatId: string,
  t: PoolToken,
  address: string,
): Promise<TgOk | TgFail> {
  const text = caption(t, address)
  const photo = httpsImage(t)
  if (photo) {
    const photoRes = await telegramCall('sendPhoto', token, {
      chat_id: chatId,
      photo,
      caption: text,
      parse_mode: 'HTML',
    })
    if (photoRes.ok) return photoRes
  }
  return telegramCall('sendMessage', token, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  })
}

async function saddAll(members: string[]): Promise<void> {
  const CHUNK = 64
  for (let i = 0; i < members.length; i += CHUNK) {
    const chunk = members.slice(i, i + CHUNK)
    if (chunk.length) await kv.sadd(POSTED_KEY, ...chunk)
  }
}

export async function runTelegramLaunchTick(): Promise<TelegramLaunchTickResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!botToken || !chatId) {
    const skipped = !botToken ? 'TELEGRAM_BOT_TOKEN unset' : 'TELEGRAM_CHAT_ID unset'
    return { ok: true, skipped, seeded: 0, posted: 0, errors: [], addresses: [] }
  }

  const { tokens } = await getArcHomeCatalog()
  const raw = await kv.smembers<string>(POSTED_KEY)
  const postedSet = new Set((Array.isArray(raw) ? raw : []).map((s) => String(s).toLowerCase()))

  if (postedSet.size === 0) {
    if (tokens.length === 0) {
      return { ok: true, seeded: 0, posted: 0, errors: [], addresses: [] }
    }
    const addrs = [...new Set(tokens.map(identity).filter(Boolean))]
    if (addrs.length) await saddAll(addrs)
    return { ok: true, seeded: addrs.length, posted: 0, errors: [], addresses: [] }
  }

  const candidates = tokens
    .filter((t) => {
      const id = identity(t)
      if (!id || postedSet.has(id)) return false
      if (isHiddenToken(t.coinType || t.poolId || id)) return false
      return true
    })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(0, MAX_PER_TICK)

  const errors: string[] = []
  const addresses: string[] = []
  let posted = 0

  for (const t of candidates) {
    const address = identity(t)
    const res = await sendLaunch(botToken, chatId, t, address)
    if (!res.ok) {
      errors.push(`${address}: ${res.error}`)
      continue
    }
    await kv.sadd(POSTED_KEY, address)
    posted += 1
    addresses.push(address)
  }

  return { ok: errors.length === 0, seeded: 0, posted, errors, addresses }
}
