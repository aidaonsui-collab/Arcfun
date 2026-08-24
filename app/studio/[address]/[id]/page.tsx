import Link from 'next/link'
import { getCollection, getItem } from '@/lib/port/catalog'
import { getActivity, syncCollection } from '@/lib/port/market'
import { ItemView } from './ItemView'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string; id: string }> | { address: string; id: string }
}) {
  const { address, id } = await Promise.resolve(params)
  const collection = await getCollection(address)
  const item = await getItem(address, Number(id))
  return {
    title: item && collection ? `${item.name} — ArcStudio` : 'ArcStudio — Arcfun',
  }
}

export default async function ItemPage({
  params,
}: {
  params: Promise<{ address: string; id: string }> | { address: string; id: string }
}) {
  const { address, id } = await Promise.resolve(params)
  const tokenId = Number(id)
  const collection = await getCollection(address)
  const item = await getItem(address, tokenId)

  if (!collection || !item) {
    return (
      <main className="min-h-screen pt-32 pb-20 text-center text-white">
        <h1 className="text-[32px] font-semibold tracking-display">Item not found</h1>
        <p className="mt-2 text-t3">It hasn’t been minted, or the id is wrong.</p>
        <Link
          href={`/studio/${address}`}
          className="mt-6 inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white hover:text-white"
        >
          Back to collection
        </Link>
      </main>
    )
  }

  const [market, activity] = await Promise.all([
    syncCollection(collection.address),
    getActivity(collection.address, String(tokenId)),
  ])
  const listing = market.listings.find((l) => l.tokenId === String(tokenId)) ?? null
  return (
    <main className="min-h-screen pt-16 text-white">
      <ItemView collection={collection} item={item} listing={listing} activity={activity} />
    </main>
  )
}
