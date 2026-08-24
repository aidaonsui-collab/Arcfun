import { getCollection } from '@/lib/port/catalog'
import { collectionOgImage, fallbackOgImage, OG_SIZE } from '@/lib/port/og-card'

export const runtime = 'nodejs'
export const alt = 'ArcStudio collection'
export const size = OG_SIZE
export const contentType = 'image/png'
export const revalidate = 300

export default async function Image({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params
  try {
    const collection = await getCollection(address)
    if (!collection) return fallbackOgImage()
    return collectionOgImage(collection)
  } catch {
    return fallbackOgImage()
  }
}