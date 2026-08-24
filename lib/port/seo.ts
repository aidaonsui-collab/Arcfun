import type { Metadata } from 'next'
import type { Collection, NftItem } from './types'
import { formatInt, formatUsdc } from './format'
import { studioPath } from './path'

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

/** Prefetch a remote image as a data URI so ImageResponse does not fail the whole card. */
export async function fetchOgImageSrc(
  url: string | undefined | null,
  size: { width: number; height: number } = { width: 1200, height: 630 },
): Promise<string | null> {
  const abs = absoluteAsset(url)
  if (!abs) return null
  const src = compactCloudinary(abs, size.width, size.height)
  try {
    const res = await fetch(src, { cache: 'no-store' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 32 || buf.length > 6_000_000) return null
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
    if (!ct.startsWith('image/')) return null
    return `data:${ct};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}