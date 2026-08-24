import { getCollection, getItem } from '@/lib/port/catalog'
import { fallbackOgImage, itemOgImage, OG_SIZE } from '@/lib/port/og-card'

export const runtime = 'nodejs'
export const alt = 'ArcStudio item'
export const size = OG_SIZE
export const contentType = 'image/png'
export const revalidate = 300

export default async function Image({
  params,
}: {
  params: Promise<{ address: string; id: string }>
}) {
  const { address, id } = await params
  try {
    const collection = await getCollection(address)
    const item = await getItem(address, Number(id))
    if (!collection || !item) return fallbackOgImage()
    return itemOgImage(collection, item)
  } catch {
    return fallbackOgImage()
  }
}