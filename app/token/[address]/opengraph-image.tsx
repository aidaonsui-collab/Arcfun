import { createHash } from 'node:crypto'
import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'
import { fallbackTokenOgImage, OG_SIZE, tokenOgImage } from '@/lib/arc-og'

export const runtime = 'nodejs'
export const alt = 'eve.fun token'
export const size = OG_SIZE
export const contentType = 'image/png'
export const revalidate = 60

function artId(imageUrl: string | undefined, symbol: string): string {
  return createHash('sha256')
    .update(`${imageUrl || ''}|${symbol}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Next prefers file-based opengraph-image over generateMetadata.images, and the default
 * content-hash query does not change when KV listing art is written after launch. Emit an
 * art-keyed `id` so og:image becomes .../opengraph-image/<id> and crawlers refetch after
 * Sign and save.
 */
export async function generateImageMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<{ id: string; alt: string; size: typeof OG_SIZE; contentType: string }[]> {
  const { address } = await params
  if (!isPlausibleEvmAddress(address) || isHiddenToken(address)) {
    return [{ id: 'fallback', alt: 'eve.fun token', size: OG_SIZE, contentType: 'image/png' }]
  }
  const meta = await getArcTokenMeta(address).catch(() => null)
  const symbol = (meta?.symbol || '').trim() || address.slice(0, 6)
  return [
    {
      id: artId(meta?.imageUrl, symbol),
      alt: `$${symbol} on eve.fun`,
      size: OG_SIZE,
      contentType: 'image/png',
    },
  ]
}

export default async function Image({
  params,
}: {
  params: Promise<{ address: string }>
  id: string
}) {
  const { address } = await params
  if (!isPlausibleEvmAddress(address) || isHiddenToken(address)) {
    return fallbackTokenOgImage()
  }
  try {
    const meta = await getArcTokenMeta(address)
    return tokenOgImage({
      address,
      name: meta?.name,
      symbol: meta?.symbol,
      imageUrl: meta?.imageUrl,
    })
  } catch {
    return fallbackTokenOgImage()
  }
}
