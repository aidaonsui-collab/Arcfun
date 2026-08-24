import { type Address } from 'viem'
import { arcPublicClient } from '@/lib/contracts-arc'
import { PORT_NFT_ABI } from './abi'
import { getCollection } from './catalog'
import { getPortItems, rarityOf } from './item-meta'
import type { Trait } from './types'

const CHUNK = 100
const MAX = 2000

export type TokenHolder = {
  tokenId: number
  owner: string
  name: string
  rarity: string
  traits: Trait[]
}

export async function listTokenHolders(collection: string): Promise<{
  minted: number
  holders: TokenHolder[]
}> {
  const col = await getCollection(collection)
  if (!col || col.minted <= 0) return { minted: 0, holders: [] }
  const n = Math.min(col.minted, MAX)
  const store = await getPortItems(col.address)
  const client = arcPublicClient()
  const owners: (string | null)[] = Array.from({ length: n }, () => null)
  for (let i = 0; i < n; i += CHUNK) {
    const count = Math.min(CHUNK, n - i)
    const reads = await client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: count }, (_, j) => ({
        address: col.address as Address,
        abi: PORT_NFT_ABI,
        functionName: 'ownerOf' as const,
        args: [BigInt(i + j + 1)] as const,
      })),
    })
    reads.forEach((row, j) => {
      if (row.status === 'success') owners[i + j] = String(row.result)
    })
  }
  const holders: TokenHolder[] = []
  for (let i = 0; i < n; i++) {
    const owner = owners[i]
    if (!owner) continue
    const id = i + 1
    const meta = store.items[String(id)]
    const traits = meta?.traits?.filter((t) => t.type && t.value) ?? []
    holders.push({
      tokenId: id,
      owner,
      name: meta?.name || `${col.name} #${id}`,
      rarity: rarityOf(traits),
      traits,
    })
  }
  return { minted: col.minted, holders }
}

export function aggregateAirdrop(
  holders: TokenHolder[],
  opts: { rarity?: string; perNft: boolean; amountAtomic: bigint },
): { wallets: Address[]; amounts: bigint[]; nfts: number; unique: number } {
  const filtered = opts.rarity
    ? holders.filter((h) => h.rarity.toLowerCase() === opts.rarity!.toLowerCase())
    : holders
  const map = new Map<string, bigint>()
  for (const h of filtered) {
    const key = h.owner.toLowerCase()
    const add = opts.perNft ? opts.amountAtomic : map.has(key) ? 0n : opts.amountAtomic
    map.set(key, (map.get(key) || 0n) + add)
  }
  const wallets: Address[] = []
  const amounts: bigint[] = []
  for (const [w, amt] of map) {
    if (amt <= 0n) continue
    wallets.push(w as Address)
    amounts.push(amt)
  }
  return { wallets, amounts, nfts: filtered.length, unique: wallets.length }
}
