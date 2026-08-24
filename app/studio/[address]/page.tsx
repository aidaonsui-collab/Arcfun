import Link from 'next/link'
import { redirect } from 'next/navigation'
import { countOwners, getCollection, getItems } from '@/lib/port/catalog'
import { studioPath } from '@/lib/port/path'
import { collectionMetadata, missingStudioMetadata } from '@/lib/port/seo'
import { isListing, withListPrices } from '@/lib/port/listings'
import { getActivity, syncCollection } from '@/lib/port/market'
import { CollectionView } from './CollectionView'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
  if (!collection) return missingStudioMetadata('collection')
  return collectionMetadata(collection)
}

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
  if (collection) {
    const pretty = studioPath(collection)
    if (pretty !== `/studio/${address}`) redirect(pretty)
  }
  if (!collection) {
    return (
      <main className="min-h-screen pt-32 pb-20 text-center text-white">
        <h1 className="text-[32px] font-semibold tracking-display">Collection not found</h1>
        <p className="mt-2 text-t3">This address isn’t on ArcStudio.</p>
        <Link
          href="/studio"
          className="mt-6 inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white hover:text-white"
        >
          Back to ArcStudio
        </Link>
      </main>
    )
  }
  const [items, market, activity, owners] = await Promise.all([
    getItems(address),
    syncCollection(collection.address),
    getActivity(collection.address),
    countOwners(collection.address, collection.minted),
  ])
  const priced = withListPrices(items, market.listings.filter(isListing))
  const col = {
    ...collection,
    owners,
    floorUsdc: market.snapshot.floorUsdc,
    listed: market.snapshot.listed,
    volume24hUsdc: market.snapshot.volume24hUsdc,
    topOfferUsdc: market.snapshot.topOfferUsdc,
  }
  return (
    <main className="min-h-screen pt-16 text-white">
      <CollectionView
        collection={col}
        items={priced}
        activity={activity}
        listings={market.listings.filter(isListing)}
      />
    </main>
  )
}
