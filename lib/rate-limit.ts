/**
 * Cheap IP rate limit via Vercel KV INCR. Fail open if KV is down so a Redis blip
 * does not take the site with it.
 */
import { kv } from '@vercel/kv'
import { NextRequest, NextResponse } from 'next/server'

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  return (req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64)
}

export async function limitOr429(
  req: NextRequest,
  bucket: string,
  limit: number,
  windowSec = 60,
  failClosed = false,
): Promise<NextResponse | null> {
  const ip = clientIp(req)
  const key = `arcfun:rl:${bucket}:${ip}`
  try {
    const n = await kv.incr(key)
    if (n === 1) await kv.expire(key, windowSec)
    if (n > limit) {
      return NextResponse.json(
        { ok: false, error: 'too many requests' },
        { status: 429, headers: { 'Retry-After': String(windowSec) } },
      )
    }
  } catch {
    if (failClosed) {
      return NextResponse.json(
        { ok: false, error: 'rate limit unavailable' },
        { status: 503, headers: { 'Retry-After': String(windowSec) } },
      )
    }
  }
  return null
}
