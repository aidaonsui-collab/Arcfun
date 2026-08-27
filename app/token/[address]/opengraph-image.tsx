import { getArcTokenMeta } from '@/lib/arc-token-meta'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'
import { fallbackTokenOgImage, OG_SIZE, tokenOgImage } from '@/lib/arc-og'

export const runtime = 'nodejs'
export const alt = 'Arcfun token'
export const size = OG_SIZE
export const contentType = 'image/png'
export const revalidate = 300

export default async function Image({
  params,
}: {
  params: Promise<{ address: string }>
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
