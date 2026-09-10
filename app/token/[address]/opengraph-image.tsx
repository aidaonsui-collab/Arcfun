import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'
import {
  fallbackTokenOgImage,
  OG_SIZE,
  resolveTokenOg,
  tokenOgArtId,
  tokenOgImage,
} from '@/lib/arc-og'

export const runtime = 'nodejs'
export const alt = 'eve.fun token'
export const size = OG_SIZE
export const contentType = 'image/png'
export const revalidate = 60

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
  const { imageUrl, symbol } = await resolveTokenOg(address)
  return [
    {
      id: tokenOgArtId(imageUrl, symbol),
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
    const { imageUrl, name, symbol } = await resolveTokenOg(address)
    return tokenOgImage({ address, name, symbol, imageUrl })
  } catch {
    return fallbackTokenOgImage()
  }
}
