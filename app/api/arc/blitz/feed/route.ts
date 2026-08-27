import { NextRequest, NextResponse } from 'next/server'
import { limitOr429 } from '@/lib/rate-limit'
import { sanitizeHandle, DEFAULT_WATCH } from '@/lib/arc-blitz'
import { fetchWatchFeed, blitzWatchLive } from '@/lib/arc-blitz-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

export async function GET(req: NextRequest) {
  const blocked = await limitOr429(req, 'blitz-feed', 20, 60)
  if (blocked) return blocked
  const raw = (req.nextUrl.searchParams.get('handles') || '').trim()
  const handles = (raw ? raw.split(',') : [...DEFAULT_WATCH]).map(sanitizeHandle).filter(Boolean).slice(0, 8)
  try {
    const { tweets, live } = await fetchWatchFeed(handles)
    return NextResponse.json({ tweets, live, watch: blitzWatchLive() })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'feed failed'
    return NextResponse.json({ tweets: [], live: false, watch: blitzWatchLive(), error: msg }, { status: 200 })
  }
}
