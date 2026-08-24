import { isAddress, type Address } from 'viem'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from './abi'

export async function readCollectionOwner(collection: string): Promise<Address | null> {
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
    return (await client.readContract({
      address: collection as Address,
      abi: PORT_NFT_ABI,
      functionName: 'owner',
    })) as Address
  } catch {
    return null
  }
}
