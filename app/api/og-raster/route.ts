/**
 * GET /api/og-raster?u=<https image>&w=630&h=630
 * Transcode Blob webp/avif to PNG for next/og (satori cannot decode webp).
 * Runs as a normal Node function so sharp native binaries actually load.
 */
import { NextRequest, NextResponse } from 'next/server'
import { rasterToPng } from '@/lib/og-transcode'
import { limitOr429 } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HOST_OK = [
  /(^|\.)public\.blob\.vercel-storage\.com$/i,
  /(^|\.)res\.cloudinary\.com$/i,
]

function clampDim(raw: string | null, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1200, Math.max(32, Math.round(n)))
}

export async function GET(req: NextRequest) {
  const limited = await limitOr429(req, 'og-raster', 30, 60)
  if (limited) return limited

  const raw = (req.nextUrl.searchParams.get('u') || '').trim()
  let src: URL
  try {
    src = new URL(raw)
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }
  if (src.protocol !== 'https:' || !HOST_OK.some((re) => re.test(src.hostname))) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 400 })
  }

  const width = clampDim(req.nextUrl.searchParams.get('w'), 630)
  const height = clampDim(req.nextUrl.searchParams.get('h'), 630)

  try {
    const res = await fetch(src.toString(), { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 })
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 32 || buf.length > 6_000_000) {
      return NextResponse.json({ error: 'bad image size' }, { status: 400 })
    }
    const png = await rasterToPng(buf, width, height)
    if (!png) return NextResponse.json({ error: 'transcode failed' }, { status: 502 })
    return new NextResponse(new Uint8Array(png), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
      },
    })
  } catch (e) {
    console.error('[og-raster]', e)
    return NextResponse.json({ error: 'transcode failed' }, { status: 502 })
  }
}