import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCollection } from '@/lib/port/catalog'
import { studioPath } from '@/lib/port/path'
import { AirdropDesk } from '@/components/port/AirdropDesk'

export const dynamic = 'force-dynamic'

export default async function CollectionAirdropPage({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  const collection = await getCollection(address)
  if (collection) {
    const pretty = studioPath(collection, 'airdrop')
    if (pretty !== `/studio/${address}/airdrop`) redirect(pretty)
  }
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
      <AirdropDesk collection={collection} />
    </main>
  )
}
