/**
 * ArcStudio profile: collections launched, primary mint earnings, items held.
 */
import { type Address } from 'viem'
import { arcPublicClient } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { getCreatorMeta, type CreatorMeta } from '@/lib/arc-creator-meta'
import { PORT_NFT_ABI } from './abi'
import { listCollections } from './catalog'
import { getPortItems } from './item-meta'
import { CREATOR_SHARE, type Collection, type NftItem } from './types'

const MAX_OWNER_SCAN = 400

export type StudioLaunched = {
  collection: Collection
  primaryEarnedUsdc: number
}

export type StudioProfile = {
  address: string
  meta: CreatorMeta
  launched: StudioLaunched[]
  held: NftItem[]
  heldCollections: Collection[]
  primaryEarnedUsdc: number
}

export async function getStudioProfile(raw: string): Promise<StudioProfile | null> {
  if (!isPlausibleEvmAddress(raw)) return null
  const address = raw.toLowerCase()
  const [all, meta] = await Promise.all([listCollections(), getCreatorMeta(address)])
  const launchedCols = all.filter((c) => c.creator.toLowerCase() === address)
  const launched: StudioLaunched[] = launchedCols.map((collection) => ({
    collection,
    primaryEarnedUsdc: collection.minted * collection.mintPriceUsdc * CREATOR_SHARE,
  }))
  const primaryEarnedUsdc = launched.reduce((s, r) => s + r.primaryEarnedUsdc, 0)
  const held = await listHeldItems(address, all)
  const heldSet = new Set(held.map((i) => i.collection.toLowerCase()))
  const heldCollections = all.filter((c) => heldSet.has(c.address.toLowerCase()))
  return { address, meta, launched, held, heldCollections, primaryEarnedUsdc }
}

async function listHeldItems(owner: string, collections: Collection[]): Promise<NftItem[]> {
  const client = arcPublicClient()
  const out: NftItem[] = []
  for (const c of collections) {
    if (c.minted <= 0) continue
    const addr = c.address as Address
    let bal = 0
    try {
      bal = Number(
        await client.readContract({
          address: addr,
          abi: PORT_NFT_ABI,
          functionName: 'balanceOf',
          args: [owner as Address],
        }),
      )
    } catch {
      bal = 0
    }
    if (!Number.isFinite(bal) || bal <= 0) continue
    const store = await getPortItems(c.address)
    const n = Math.min(c.minted, MAX_OWNER_SCAN)
    const reads = await client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: n }, (_, i) => ({
        address: addr,
        abi: PORT_NFT_ABI,
        functionName: 'ownerOf' as const,
        args: [BigInt(i + 1)] as const,
      })),
    })
    reads.forEach((row, i) => {
      if (row.status !== 'success') return
      const who = String(row.result).toLowerCase()
      if (who !== owner) return
      const id = i + 1
      const meta = store.items[String(id)]
      out.push({
        collection: c.address,
        id,
        name: meta?.name || `${c.name} #${id}`,
        image: meta?.imageUrl || c.image,
        owner,
        minted: true,
        traits: meta?.traits?.filter((t) => t.type && t.value) ?? [],
      })
    })
  }
  return out
}
