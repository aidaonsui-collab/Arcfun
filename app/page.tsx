import { HomeClient } from '@/components/HomeClient'
import { getArcHomeCatalog } from '@/lib/arc-catalog-cache'
import type { PoolToken } from '@/lib/tokens'

export const revalidate = 20

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const q = ((await searchParams).q || '').trim()
  let initialTokens: PoolToken[] = []
  try {
    initialTokens = (await getArcHomeCatalog()).tokens
  } catch {
    /* client poll fills in */
  }
  return <HomeClient initialTokens={initialTokens} initialQ={q} />
}
