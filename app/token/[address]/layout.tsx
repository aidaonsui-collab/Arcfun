import type { Metadata } from 'next'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'

/**
 * ISR for the whole /token/[address] segment.
 *
 * The page itself is 'use client' and reads its address from useParams, so it holds no
 * server data — but without segment config a dynamic route is rendered per request, and every
 * hit was returning `private, no-cache, no-store` with `x-vercel-cache: MISS`. generateMetadata
 * below also does a KV read, which was therefore running on every single request.
 *
 * 60s of shared CDN cache makes the shell a static asset and collapses that KV read to at most
 * one per token per minute. Live prices are client-fetched after hydration, so nothing
 * user-visible goes stale.
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

const SITE = 'Arcfun'
const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.arcfun.co').replace(/\/$/, '')

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || 'token'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
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
    : `Trade $${symbol} on Arcfun. Instant launch on Arc, quoted in USDC.`

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
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return children
}
