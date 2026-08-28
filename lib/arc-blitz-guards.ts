/**
 * Mention-bot spam floors. Env 0 disables that check.
 *   BLITZ_MIN_ACCOUNT_DAYS  default 30
 *   BLITZ_MIN_FOLLOWERS     default 50
 *   BLITZ_DAILY_CAP         default 20 Instant creates / UTC day
 */
import { kv } from '@vercel/kv'

export const BLITZ_AUTHOR_TTL_SEC = 24 * 60 * 60
export function blitzAuthorKey(id: string): string {
  return `arcfun:blitz:bot:author:${id}`
}

export function blitzMinAccountDays(): number {
  const n = Number(process.env.BLITZ_MIN_ACCOUNT_DAYS)
  return Number.isFinite(n) && n >= 0 ? n : 30
}

export function blitzMinFollowers(): number {
  const n = Number(process.env.BLITZ_MIN_FOLLOWERS)
  return Number.isFinite(n) && n >= 0 ? n : 50
}

export function blitzDailyCap(): number {
  const n = Number(process.env.BLITZ_DAILY_CAP)
  return Number.isFinite(n) && n >= 0 ? n : 20
}

/** Fail closed when created_at is missing. */
export function xAccountTooNew(createdAt: string | undefined, minDays = blitzMinAccountDays(), nowMs = Date.now()): boolean {
  if (minDays <= 0) return false
  if (!createdAt) return true
  const born = Date.parse(createdAt)
  if (!Number.isFinite(born)) return true
  return nowMs - born < minDays * 86_400_000
}

/** Fail closed when follower count is missing. */
export function xFollowersTooLow(count: number | undefined, min = blitzMinFollowers()): boolean {
  if (min <= 0) return false
  if (count == null || !Number.isFinite(count)) return true
  return count < min
}

function utcDayKey(nowMs = Date.now()): string {
  return `arcfun:blitz:bot:day:${new Date(nowMs).toISOString().slice(0, 10)}`
}

export async function dailyMintsUsed(): Promise<number> {
  try {
    const n = await kv.get<number>(utcDayKey())
    return typeof n === 'number' && Number.isFinite(n) ? n : Number(n || 0) || 0
  } catch {
    return blitzDailyCap()
  }
}

/** True if this mint is still under the global UTC daily cap. Increments on success. */
export async function takeDailyMintSlot(): Promise<boolean> {
  const cap = blitzDailyCap()
  if (cap <= 0) return true
  const key = utcDayKey()
  try {
    const n = await kv.incr(key)
    if (n === 1) await kv.expire(key, 2 * 86_400)
    return n <= cap
  } catch {
    return false
  }
}
