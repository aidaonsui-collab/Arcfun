import Link from 'next/link'
import { CollectionCard } from '@/components/port/CollectionCard'
import { PortHow, PortStudio } from '@/components/port/PortStudio'
import { listCollections } from '@/lib/port/catalog'

export const metadata = { title: 'ArcPort — Arcfun' }
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

  return (
    <main className="relative min-h-screen overflow-hidden pb-20 pt-16 text-white">
      <div aria-hidden="true" className="hero-grid-fade" />
      <div className="relative z-10 mx-auto w-full max-w-desk px-4 sm:px-10">
        {!searching ? <PortStudio /> : null}

        {searching ? (
          <div className="rise-in flex items-end justify-between gap-4 pb-8 pt-8 sm:pt-12">
            <div className="min-w-0">
              <h1 className="text-[32px] font-semibold leading-[1.05] tracking-display sm:text-[40px]">
                Search
              </h1>
              <p className="mt-2 text-[15px] text-t3">Results for “{q}”</p>
            </div>
          </div>
        ) : list.length > 0 ? (
          <div className="mt-10 flex items-end justify-between gap-4">
            <h2 className="text-[21px] font-semibold tracking-tightish">Collections</h2>
            <Link
              href="/port/create"
              className="text-[13px] font-semibold text-t3 hover:text-white"
            >
              Create
            </Link>
          </div>
        ) : (
          <PortHow />
        )}

        {list.length === 0 ? (
          searching ? (
            <div className="mt-2 rounded-[24px] border border-hair bg-s1 px-6 py-16 text-center">
              <p className="text-[17px] font-semibold tracking-tightish">No collections for “{q}”</p>
              <p className="mt-2 text-[15px] text-t3">Try another name, ticker, or address.</p>
            </div>
          ) : null
        ) : (
          <div
            className={`grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4 ${
              searching ? '' : 'mt-5'
            }`}
          >
            {list.map((c) => (
              <CollectionCard key={c.address} collection={c} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
