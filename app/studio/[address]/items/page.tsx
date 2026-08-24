import Link from 'next/link'
import { getCollection } from '@/lib/port/catalog'
import { ItemDesk } from '@/components/port/ItemDesk'

export const dynamic = 'force-dynamic'

export default async function CollectionItemsPage({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
  if (!collection) {
    return (
      <main className="min-h-screen pt-32 text-center text-white">
        <p className="text-t2">Collection not found.</p>
        <Link href="/studio" className="mt-4 inline-block text-lime-t">
          Back to Studio
        </Link>
      </main>
    )
  }
  return (
    <main className="min-h-screen pt-16 text-white">
      <ItemDesk collection={collection} />
    </main>
  )
}
