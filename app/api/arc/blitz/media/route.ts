import { NextRequest, NextResponse } from 'next/server'
import { limitOr429 } from '@/lib/rate-limit'
import { blitzLaunchEnabled } from '@/lib/arc-blitz'
import { allowedMediaUrl } from '@/lib/arc-blitz-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const MAX_BYTES = 4_000_000

export async function GET(req: NextRequest) {
  if (!blitzLaunchEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const blocked = await limitOr429(req, 'blitz-media', 40, 60)
  if (blocked) return blocked
  const src = allowedMediaUrl((req.nextUrl.searchParams.get('u') || '').trim())
  if (!src) return NextResponse.json({ error: 'bad image' }, { status: 400 })
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 8_000)
    const res = await fetch(src, {
      signal: ac.signal,
      headers: { 'User-Agent': 'ArcfunBlitz/1.0' },
      redirect: 'follow',
    })
    clearTimeout(t)
    if (!res.ok) return NextResponse.json({ error: 'image fetch failed' }, { status: 502 })
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (!ct.startsWith('image/')) return NextResponse.json({ error: 'not an image' }, { status: 400 })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 32 || buf.length > MAX_BYTES) {
      return NextResponse.json({ error: 'image size' }, { status: 400 })
    }
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    })
  } catch {
    return NextResponse.json({ error: 'image fetch failed' }, { status: 502 })
  }
}
