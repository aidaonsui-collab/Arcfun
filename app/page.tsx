import { HomeClient } from '@/components/HomeClient'
import { getArcHomeCatalog } from '@/lib/arc-catalog-cache'
import type { PoolToken } from '@/lib/tokens'

/**
 * `revalidate` here was dead until 2026-08-29: reading `searchParams` in a server component
 * opts the route into dynamic rendering, so the page was rendered per request and served
 * `no-store` despite this setting. The shell regenerates at most every 2 minutes;
 * the client poll fills prices in between.
 *
 * `?q=` is a client-side filter over a list the client already polls, so it never needed to
 * reach the server. HomeClient reads it via useSearchParams inside the Suspense boundary below,
 * which keeps this shell prerenderable.
 */
export const revalidate = 120

export default async function HomePage() {
  let initialTokens: PoolToken[] = []
  try {
    initialTokens = (await getArcHomeCatalog()).tokens
  } catch {
    /* client poll fills in */
  }
  return <HomeClient initialTokens={initialTokens} />
}
