import type { Metadata } from 'next'
import type { Collection, NftItem } from './types'
import { formatInt, formatUsdc } from './format'
import { studioPath } from './path'
import { rasterToPngDataUri } from '@/lib/og-transcode'

const STUDIO = 'ArcStudio'

export function absoluteAsset(src: string | undefined | null): string | null {
  if (!src) return null
  const s = src.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${s.slice(7)}`
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.arcfun.co').replace(/\/$/, '')
  if (s.startsWith('/')) return `${base}${s}`
  return `${base}/${s}`
}

export function collectionShareTitle(c: Collection): string {
  const floor =
    c.floorUsdc != null && Number.isFinite(c.floorUsdc)
      ? ` ${formatUsdc(c.floorUsdc)} USDC`
      : ''
  return `${c.name}${floor} - Collection | ${STUDIO}`
}

export function collectionShareDescription(c: Collection): string {
  const d = c.description?.replace(/\s+/g, ' ').trim()
  if (d) return d.length > 220 ? `${d.slice(0, 217)}…` : d
  const n = c.maxSupply > 0 ? formatInt(c.maxSupply) : formatInt(c.minted)
  return `${c.name} is a collection of ${n} items on ${STUDIO}.`
}

export function itemShareTitle(c: Collection, item: NftItem): string {
  return `${item.name} | ${c.name} | ${STUDIO}`
}

export function itemShareDescription(c: Collection, item: NftItem): string {
  return `${item.name} from ${c.name} on ${STUDIO}.`
}

export function collectionMetadata(c: Collection): Metadata {
  const title = collectionShareTitle(c)
  const description = collectionShareDescription(c)
  const path = studioPath(c)
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: STUDIO,
      locale: 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

export function itemMetadata(c: Collection, item: NftItem): Metadata {
  const title = itemShareTitle(c, item)
  const description = itemShareDescription(c, item)
  const path = studioPath(c, item.id)
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: STUDIO,
      locale: 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

export function missingStudioMetadata(kind: 'collection' | 'item'): Metadata {
  const title = kind === 'item' ? `Item not found | ${STUDIO}` : `Collection not found | ${STUDIO}`
  return {
    title,
    openGraph: { title, siteName: STUDIO, type: 'website' },
    twitter: { card: 'summary', title },
  }
}

function compactCloudinary(url: string, width: number, height: number): string {
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/i)
  if (!m) return url
  const rest = m[2]
  if (/^(v\d+\/)?$/.test(rest)) return url
  if (/^[a-z0-9_,.:-]+\/v\d+\//i.test(rest) || /w_\d+/.test(rest.split('/')[0] || '')) return url
  return `${m[1]}w_${width},h_${height},c_fill,q_70,f_jpg/${rest}`
}

/** next/og (satori) only sizes/paints png, jpeg, gif, svg. WebP/AVIF throw and the <img> is empty. */
const SATORI_OK = new Set(['image/png', 'image/apng', 'image/jpeg', 'image/jpg', 'image/gif', 'image/svg+xml'])

function rasterApiOrigin(): string {
  // Use the public alias, not VERCEL_URL — the unique *.vercel.app host is
  // deployment-protected and the OG function gets 401 HTML instead of PNG.
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://www.eve.fun'
  )
    .replace(/\/$/, '')
    .replace('arcfun.vercel.app', 'www.eve.fun')
    .replace('www.arcfun.co', 'www.eve.fun')
    .replace('arcfun.co', 'www.eve.fun')
}

/** OG image bundles often drop sharp natives. Transcode in /api/og-raster instead. */
async function rasterViaApi(
  src: string,
  size: { width: number; height: number },
): Promise<string | null> {
  const origin = rasterApiOrigin()
  if (!origin.startsWith('https://')) return null
  const api = `${origin}/api/og-raster?u=${encodeURIComponent(src)}&w=${size.width}&h=${size.height}`
  try {
    const res = await fetch(api, { cache: 'no-store', signal: AbortSignal.timeout(12_000) })
    if (!res.ok) {
      console.error('[fetchOgImageSrc] raster api', res.status)
      return null
    }
    const png = Buffer.from(await res.arrayBuffer())
    if (png.length < 32 || png[0] !== 0x89) return null
    return `data:image/png;base64,${png.toString('base64')}`
  } catch (e) {
    console.error('[fetchOgImageSrc] raster api', e)
    return null
  }
}

function sniffImageType(buf: Buffer, headerType: string): string {
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii')
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  return headerType
}

/** Prefetch a remote image as a data URI so ImageResponse does not fail the whole card. */
export async function fetchOgImageSrc(
  url: string | undefined | null,
  size: { width: number; height: number } = { width: 1200, height: 630 },
): Promise<string | null> {
  const abs = absoluteAsset(url)
  if (!abs) return null
  const src = compactCloudinary(abs, size.width, size.height)
  try {
    const res = await fetch(src, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      console.error('[fetchOgImageSrc] fetch', res.status, src.slice(0, 80))
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 32 || buf.length > 6_000_000) return null
    const headerType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
    if (!headerType.startsWith('image/') && !sniffImageType(buf, '').startsWith('image/')) return null
    const kind = sniffImageType(buf, headerType)
    if (kind === 'image/svg+xml') {
      return `data:image/svg+xml;base64,${buf.toString('base64')}`
    }
    if (!SATORI_OK.has(kind)) {
      const viaApi = await rasterViaApi(src, size)
      if (viaApi) return viaApi
      return rasterToPngDataUri(buf, size.width, size.height)
    }
    const ct = kind === 'image/jpg' ? 'image/jpeg' : kind
    return `data:${ct};base64,${buf.toString('base64')}`
  } catch (e) {
    console.error('[fetchOgImageSrc]', e)
    return null
  }
}