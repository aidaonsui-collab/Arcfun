import { NextRequest, NextResponse } from 'next/server'
import { limitOr429 } from '@/lib/rate-limit'
import { blitzLaunchEnabled, draftFromTweet } from '@/lib/arc-blitz'
import { fetchTweetByUrl } from '@/lib/arc-blitz-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function GET(req: NextRequest) {
  if (!blitzLaunchEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const blocked = await limitOr429(req, 'blitz-tweet', 30, 60)
  if (blocked) return blocked
  const url = (req.nextUrl.searchParams.get('url') || '').trim()
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })
  try {
    const tweet = await fetchTweetByUrl(url)
    return NextResponse.json({ tweet, draft: draftFromTweet(tweet) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'lookup failed'
    return NextResponse.json({ error: msg }, { status: 404 })
  }
}
