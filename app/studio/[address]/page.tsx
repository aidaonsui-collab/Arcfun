import Link from 'next/link'
import { getCollection, getItems } from '@/lib/port/catalog'
import { CollectionView } from './CollectionView'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
  return { title: collection ? `${collection.name} — ArcStudio` : 'ArcStudio — Arcfun' }
}

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
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
  return (
    <main className="min-h-screen pt-16 text-white">
      <CollectionView collection={collection} items={await getItems(address)} />
    </main>
  )
}
