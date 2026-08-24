import { isAddress, type Address } from 'viem'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from './abi'

export type CollectionAuthContext = {
  owner: Address
  revealed: boolean
}

export async function readCollectionOwner(collection: string): Promise<Address | null> {
  const ctx = await readCollectionAuthContext(collection)
  return ctx?.owner ?? null
}

export async function readCollectionAuthContext(collection: string): Promise<CollectionAuthContext | null> {
  if (!isAddress(collection)) return null
  const client = arcPublicClient()
  try {
    const ok = await client.readContract({
      address: ARC.NFT_FACTORY,
      abi: PORT_FACTORY_ABI,
      functionName: 'isCollection',
      args: [collection as Address],
    })
    if (!ok) return null
    const [owner, revealed] = await Promise.all([
      client.readContract({
        address: collection as Address,
        abi: PORT_NFT_ABI,
        functionName: 'owner',
      }) as Promise<Address>,
      client.readContract({
        address: collection as Address,
        abi: PORT_NFT_ABI,
        functionName: 'revealed',
      }) as Promise<boolean>,
    ])
    return { owner, revealed: Boolean(revealed) }
  } catch {
    return null
  }
}
