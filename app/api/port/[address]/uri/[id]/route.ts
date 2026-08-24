import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getCollection } from '@/lib/port/catalog'
import { getPortItem } from '@/lib/port/item-meta'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string; id: string }> },
) {
  const { address, id: rawId } = await params
  const id = Number(rawId)
  if (!isAddress(address) || !Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 })
  }
  const collection = await getCollection(address)
  if (!collection) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const item = await getPortItem(address, id)
  const name = item?.name || `${collection.name} #${id}`
  const image = item?.imageUrl || collection.image
  return NextResponse.json(
    {
      name,
      description: item?.description || collection.description || '',
      image,
      attributes: [{ trait_type: 'Token ID', value: id }],
    },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  )
}
