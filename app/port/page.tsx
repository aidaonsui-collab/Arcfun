import Link from 'next/link'
import { CollectionCard } from '@/components/port/CollectionCard'
import { listCollections } from '@/lib/port/catalog'
import { arcPortEnabled } from '@/lib/port/contracts'

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
  const live = arcPortEnabled()

  return (
    <main className="min-h-screen pt-16 pb-20 text-white">
      <div className="mx-auto w-full max-w-desk px-4 sm:px-10">
        <div className="rise-in flex items-end justify-between gap-4 pb-8 pt-8 sm:pt-12">
          <div className="min-w-0">
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-display sm:text-[56px]">
              ArcPort
            </h1>
            <p className="mt-2 text-[15px] text-t3 sm:text-[17px]">NFT launchpad and marketplace on Arc</p>
          </div>
          <Link
            href="/port/create"
            className="mb-1 inline-flex h-9 shrink-0 items-center rounded-xl bg-lime px-3.5 text-sm font-semibold text-white hover:bg-lime-2 hover:text-white"
          >
            Create
          </Link>
        </div>
        {list.length === 0 ? (
          <div className="rounded-[24px] border border-hair bg-s1 px-6 py-16 text-center">
            <p className="text-[17px] font-semibold tracking-tightish">
              {q
                ? `No collections for “${q}”`
                : live
                  ? 'No collections yet'
                  : 'Marketplace is ready'}
            </p>
            <p className="mt-2 text-[15px] text-t3">
              {live
                ? 'Creators launch collections here. Collectors mint in USDC.'
                : 'Factory not deployed yet. Create and mint go live on the same factory tx.'}
            </p>
            <Link
              href="/port/create"
              className="mt-6 inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white hover:text-white"
            >
              Create collection
            </Link>
          </div>
        ) : (
          <div className="rise-in-2 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((c) => (
              <CollectionCard key={c.address} collection={c} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
