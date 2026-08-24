import { CollectionTable } from '@/components/port/CollectionTable'
import { FeaturedCollectionCard } from '@/components/port/FeaturedCollectionCard'
import { FeaturedRail } from '@/components/port/FeaturedRail'
import { MarketActivityList } from '@/components/port/MarketActivityList'
import { PortHow, PortStudio } from '@/components/port/PortStudio'
import { listCollections } from '@/lib/port/catalog'
import { getActivity, getGlobalActivity, type MarketActivity } from '@/lib/port/market'

export const metadata = { title: 'ArcStudio — Arcfun' }
export const dynamic = 'force-dynamic'

export default async function PortHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }> | { q?: string }
}) {
  const sp = await Promise.resolve(searchParams)
  const q = sp.q?.trim().toLowerCase()
  const [collections, global] = await Promise.all([listCollections(), getGlobalActivity(40)])
  const tapes =
    collections.length > 0
      ? await Promise.all(collections.slice(0, 12).map((c) => getActivity(c.address)))
      : []
  const seen = new Set<string>()
  const activity: MarketActivity[] = []
  for (const e of [...global, ...tapes.flat()].sort((a, b) => b.at - a.at)) {
    const k = `${e.orderHash}:${e.type}`
    if (seen.has(k)) continue
    seen.add(k)
    activity.push(e)
    if (activity.length >= 40) break
  }
  const list = q
    ? collections.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.symbol.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q) ||
          c.slug.toLowerCase().includes(q),
      )
    : collections

  const searching = Boolean(q)
  const empty = list.length === 0

  return (
    <main className="relative min-h-screen overflow-hidden pb-20 pt-16 text-white">
      <div aria-hidden="true" className="hero-grid-fade" />
      <div className="relative z-10 mx-auto w-full max-w-desk px-4 sm:px-10">
        {searching ? (
          <div className="rise-in flex items-end justify-between gap-4 pb-6 pt-8 sm:pt-10">
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold leading-[1.1] tracking-display sm:text-[32px]">
                Search
              </h1>
              <p className="mt-1.5 text-[15px] text-t3">Results for “{q}”</p>
            </div>
          </div>
        ) : empty ? (
          <>
            <PortStudio />
            <PortHow />
          </>
        ) : (
          <div className="rise-in pb-4 pt-8 sm:pt-10">
            <h1 className="text-[28px] font-semibold leading-[1.1] tracking-display sm:text-[32px]">
              Featured
            </h1>
            <p className="mt-1.5 text-[15px] text-t2">Live collections on Arc. Mint in USDC.</p>
          </div>
        )}

        {empty ? (
          searching ? (
            <div className="mt-2 rounded-[24px] border border-hair bg-s1 px-6 py-16 text-center">
              <p className="text-[17px] font-semibold tracking-tightish">No collections for “{q}”</p>
              <p className="mt-2 text-[15px] text-t3">Try another name, ticker, or address.</p>
            </div>
          ) : null
        ) : (
          <>
            {!searching ? (
              <FeaturedRail>
                {list.slice(0, 8).map((c) => (
                  <FeaturedCollectionCard key={c.address} collection={c} />
                ))}
              </FeaturedRail>
            ) : null}
            <div className={searching ? 'mt-2' : 'mt-10'}>
              {!searching ? (
                <h2 className="mb-4 text-[21px] font-semibold tracking-tightish">Collections</h2>
              ) : null}
              <CollectionTable collections={list} />
            </div>
            {!searching ? (
              <div className="mt-10">
                <h2 className="mb-4 text-[21px] font-semibold tracking-tightish">Activity</h2>
                <MarketActivityList
                  events={activity}
                  names={Object.fromEntries(collections.map((c) => [c.address.toLowerCase(), c.name]))}
                  slugs={Object.fromEntries(
                    collections.map((c) => [c.address.toLowerCase(), c.slug || c.address]),
                  )}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
