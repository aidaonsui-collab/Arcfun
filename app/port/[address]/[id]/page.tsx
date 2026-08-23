import Link from 'next/link'
import { getCollection, getItem } from '@/lib/port/catalog'
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
    title: item && collection ? `${item.name} — ArcPort` : 'ArcPort — Arcfun',
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
          href={`/port/${address}`}
          className="mt-6 inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white hover:text-white"
        >
          Back to collection
        </Link>
      </main>
    )
  }

  return (
    <main className="min-h-screen pt-16 text-white">
      <ItemView collection={collection} item={item} />
    </main>
  )
}
