import { erc20Abi, formatUnits, type Address } from 'viem'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from './abi'
import { arcPortEnabled } from './contracts'
import { getPortCollectionMeta, getPortCollectionMetas } from './meta'
import type { Collection, NftItem } from './types'

const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000'
const MAX_LIST = 200

function asAddr(v: unknown): Address | null {
  if (typeof v !== 'string' || !isPlausibleEvmAddress(v)) return null
  return v as Address
}

async function loadOne(
  address: Address,
  meta?: Awaited<ReturnType<typeof getPortCollectionMeta>>,
): Promise<Collection | null> {
  const client = arcPublicClient()
  try {
    const hidden = await client.readContract({
      address: ARC.NFT_FACTORY,
      abi: PORT_FACTORY_ABI,
      functionName: 'hidden',
      args: [address],
    })
    if (hidden) return null

    const [name, symbol, owner, uri, maxSupply, maxPerWallet, price, minted, start, root, payout, royalty, origin] =
      await client.multicall({
        allowFailure: true,
        contracts: [
          { address, abi: PORT_NFT_ABI, functionName: 'name' },
          { address, abi: PORT_NFT_ABI, functionName: 'symbol' },
          { address, abi: PORT_NFT_ABI, functionName: 'owner' },
          { address, abi: PORT_NFT_ABI, functionName: 'unrevealedURI' },
          { address, abi: PORT_NFT_ABI, functionName: 'maxSupply' },
          { address, abi: PORT_NFT_ABI, functionName: 'maxPerWallet' },
          { address, abi: PORT_NFT_ABI, functionName: 'price' },
          { address, abi: PORT_NFT_ABI, functionName: 'totalMinted' },
          { address, abi: PORT_NFT_ABI, functionName: 'publicMintStart' },
          { address, abi: PORT_NFT_ABI, functionName: 'allowlistRoot' },
          { address, abi: PORT_NFT_ABI, functionName: 'creatorPayout' },
          { address, abi: PORT_NFT_ABI, functionName: 'royaltyInfo', args: [1n, 10_000n] },
          { address, abi: PORT_NFT_ABI, functionName: 'originToken' },
        ],
      })

    if (name.status !== 'success' || typeof name.result !== 'string') return null
    const priceRaw = price.status === 'success' ? (price.result as bigint) : 0n
    const mintedN = minted.status === 'success' ? Number(minted.result) : 0
    const supplyN = maxSupply.status === 'success' ? Number(maxSupply.result) : 0
    const royaltyAmt = royalty.status === 'success' ? Number((royalty.result as [Address, bigint])[1]) : 500
    const imageOnchain = uri.status === 'success' ? String(uri.result) : ''
    const overlay = meta ?? (await getPortCollectionMeta(address))
    const image = overlay?.imageUrl || imageOnchain
    const creator = (owner.status === 'success' ? String(owner.result) : '') || overlay?.creator || ''
    const originRaw =
      origin.status === 'success' ? String(origin.result) : overlay?.originToken || ''
    const originToken =
      originRaw && originRaw !== '0x0000000000000000000000000000000000000000' ? originRaw : undefined
    let originSymbol: string | undefined
    if (originToken) {
      try {
        originSymbol = await client.readContract({
          address: originToken as Address,
          abi: erc20Abi,
          functionName: 'symbol',
        })
      } catch {
        originSymbol = undefined
      }
    }

    return {
      address,
      slug: (symbol.status === 'success' ? String(symbol.result) : address.slice(2, 8)).toLowerCase(),
      name: overlay?.name || name.result,
      symbol: overlay?.symbol || (symbol.status === 'success' ? String(symbol.result) : ''),
      description: overlay?.description || '',
      image,
      banner: overlay?.bannerUrl || image,
      creator,
      creatorRewardsWallet:
        (payout.status === 'success' ? String(payout.result) : '') || creator,
      maxSupply: Number.isFinite(supplyN) ? supplyN : 0,
      maxPerWallet: maxPerWallet.status === 'success' ? Number(maxPerWallet.result) : 0,
      mintPriceUsdc: Number(formatUnits(priceRaw, 6)),
      publicStart: start.status === 'success' ? Number(start.result) * 1000 : 0,
      allowlist: root.status === 'success' && String(root.result) !== ZERO_ROOT,
      royalty: Number.isFinite(royaltyAmt) ? Math.round(royaltyAmt) / 100 : 5,
      minted: Number.isFinite(mintedN) ? mintedN : 0,
      owners: 0,
      twitter: overlay?.twitter,
      telegram: overlay?.telegram,
      website: overlay?.website,
      originToken,
      originSymbol,
    }
  } catch {
    return null
  }
}

export async function listCollections(): Promise<Collection[]> {
  if (!arcPortEnabled()) return []
  const client = arcPublicClient()
  const factory = ARC.NFT_FACTORY
  try {
    const len = Number(
      await client.readContract({
        address: factory,
        abi: PORT_FACTORY_ABI,
        functionName: 'allCollectionsLength',
      }),
    )
    if (!Number.isFinite(len) || len <= 0) return []
    const start = Math.max(0, len - MAX_LIST)
    const addrReads = await client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: len - start }, (_, i) => ({
        address: factory,
        abi: PORT_FACTORY_ABI,
        functionName: 'allCollections' as const,
        args: [BigInt(start + i)],
      })),
    })
    const addresses = addrReads
      .map((r) => (r.status === 'success' ? asAddr(r.result) : null))
      .filter((a): a is Address => !!a)
      .reverse()
    const metas = await getPortCollectionMetas(addresses)
    const rows = await Promise.all(addresses.map((a) => loadOne(a, metas.get(a.toLowerCase()))))
    return rows.filter((c): c is Collection => !!c)
  } catch {
    return []
  }
}

export async function getCollection(address: string): Promise<Collection | undefined> {
  if (!isPlausibleEvmAddress(address) || !arcPortEnabled()) return undefined
  const client = arcPublicClient()
  try {
    const ok = await client.readContract({
      address: ARC.NFT_FACTORY,
      abi: PORT_FACTORY_ABI,
      functionName: 'isCollection',
      args: [address as Address],
    })
    if (!ok) return undefined
    return (await loadOne(address as Address)) ?? undefined
  } catch {
    return undefined
  }
}

export function itemsFor(collection: Collection): NftItem[] {
  return Array.from({ length: collection.minted }, (_, i) => {
    const id = i + 1
    return {
      collection: collection.address,
      id,
      name: `${collection.name} #${id}`,
      image: collection.image,
      owner: '',
      traits: [],
    }
  })
}

export async function getItems(address: string): Promise<NftItem[]> {
  const collection = await getCollection(address)
  if (!collection) return []
  return itemsFor(collection)
}

export async function getItem(address: string, id: number): Promise<NftItem | undefined> {
  const collection = await getCollection(address)
  if (!collection || !Number.isInteger(id) || id < 1 || id > collection.minted) return undefined
  let owner = ''
  try {
    owner = (await arcPublicClient().readContract({
      address: address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(id)],
    })) as string
  } catch {
    owner = ''
  }
  return {
    collection: collection.address,
    id,
    name: `${collection.name} #${id}`,
    image: collection.image,
    owner,
    traits: [],
  }
}
