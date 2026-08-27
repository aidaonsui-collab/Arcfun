import type { Metadata } from 'next'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'

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
