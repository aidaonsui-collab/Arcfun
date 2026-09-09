import type { Metadata } from 'next'
import { createHash } from 'node:crypto'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'

/**
 * ISR for the whole /token/[address] segment.
 *
 * The page SSRs a catalog snapshot (name / symbol / image / last price) from KV when the
 * token is already listed — first HTML is the hero, not a spinner. generateMetadata also
 * does a KV read. 60s of shared CDN cache collapses both to at most one per token per
 * minute. Live price still client-polls `/api/arc/[token]` after hydration.
 */
export const revalidate = 60

/**
 * Empty list on purpose: prerender nothing at build (token addresses are not known then), but
 * opt the segment into incremental static regeneration so each address is rendered once on
 * first request and then served from the CDN for `revalidate` seconds. Without this a dynamic
 * segment is re-rendered per request and never cached.
 */
export function generateStaticParams(): { address: string }[] {
  return []
}

const SITE = 'eve.fun'
/** Production Vercel still has NEXT_PUBLIC_APP_URL=arcfun.vercel.app — rewrite like root layout. */
const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://www.eve.fun'
)
  .replace(/\/$/, '')
  .replace('arcfun.vercel.app', 'www.eve.fun')
  .replace('www.arcfun.co', 'www.eve.fun')
  .replace('arcfun.co', 'www.eve.fun')

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || 'token'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** Telegram/X pin og:image by URL. Next's file-route content hash does not change when KV
 *  meta (pfp) is written after launch, so first crawl (letter avatar) sticks forever. Bust on
 *  imageUrl/symbol so a later Sign-and-save produces a new URL crawlers will refetch. */
function ogArtBust(imageUrl: string | undefined, symbol: string): string {
  return createHash('sha256')
    .update(`${imageUrl || ''}|${symbol}`)
    .digest('hex')
    .slice(0, 12)
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<Metadata> {
  const { address } = await params
  const path = `/token/${address}`

  if (!isPlausibleEvmAddress(address) || isHiddenToken(address)) {
    return {
      title: `Token not found | ${SITE}`,
      openGraph: { title: `Token not found | ${SITE}`, siteName: SITE, type: 'website' },
      twitter: { card: 'summary_large_image', title: `Token not found | ${SITE}` },
    }
  }

  const meta = await getArcTokenMeta(address).catch(() => null)
  const symbol = (meta?.symbol || '').trim() || shortAddr(address)
  const name = (meta?.name || '').trim() || symbol
  const title = `$${symbol} — ${name} | ${SITE}`
  const description = meta?.description?.replace(/\s+/g, ' ').trim()
    ? meta.description!.replace(/\s+/g, ' ').trim().slice(0, 220)
    : `Trade $${symbol} on eve.fun. Instant launch on Arc, quoted in USDC.`
  const ogImage = `${SITE_URL}${path}/opengraph-image?v=${ogArtBust(meta?.imageUrl, symbol)}`

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}${path}`,
      siteName: SITE,
      locale: 'en_US',
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: `$${symbol} on eve.fun` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  }
}

export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return children
}
