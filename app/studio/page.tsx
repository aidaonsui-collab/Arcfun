import { CollectionTable } from '@/components/port/CollectionTable'
import { FeaturedCollectionCard } from '@/components/port/FeaturedCollectionCard'
import { PortHow, PortStudio } from '@/components/port/PortStudio'
import { listCollections } from '@/lib/port/catalog'

export const metadata = { title: 'ArcStudio — Arcfun' }
export const dynamic = 'force-dynamic'

export default async function PortHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }> | { q?: string }
}) {
  const sp = await Promise.resolve(searchParams)
  const q = sp.q?.trim().toLowerCase()
  const collections = await listCollections()
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
              <div className="rail-scroll -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:-mx-0 sm:px-0 sm:gap-4">
                {list.slice(0, 8).map((c) => (
                  <FeaturedCollectionCard key={c.address} collection={c} />
                ))}
              </div>
            ) : null}
            <div className={searching ? 'mt-2' : 'mt-10'}>
              {!searching ? (
                <h2 className="mb-4 text-[21px] font-semibold tracking-tightish">Collections</h2>
              ) : null}
              <CollectionTable collections={list} />
            </div>
          </>
        )}
      </div>
    </main>
  )
}
