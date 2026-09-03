import { erc20Abi, formatUnits, type Address } from 'viem'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from './abi'
import { arcPortEnabled } from './contracts'
import { getPortCollectionMeta, getPortCollectionMetas } from './meta'
import { getPortItem, getPortItems } from './item-meta'
import { getSnapshot } from './market'
import { collectionSlug, withPublicSlugs } from './path'
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

    const [
      name,
      symbol,
      owner,
      uri,
      maxSupply,
      maxPerWallet,
      price,
      minted,
      start,
      root,
      payout,
      royalty,
      origin,
      revealed,
      alStart,
      alEnd,
    ] = await client.multicall({
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
          { address, abi: PORT_NFT_ABI, functionName: 'revealed' },
          { address, abi: PORT_NFT_ABI, functionName: 'allowlistMintStart' },
          { address, abi: PORT_NFT_ABI, functionName: 'allowlistMintEnd' },
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
    const bannerRaw = overlay?.bannerUrl || ''
    const banner = bannerRaw && bannerRaw !== image ? bannerRaw : ''
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

    const displayName = overlay?.name || name.result
    return {
      address,
      slug: collectionSlug({
        address,
        name: displayName,
        symbol: overlay?.symbol || (symbol.status === 'success' ? String(symbol.result) : ''),
      }),
      name: displayName,
      symbol: overlay?.symbol || (symbol.status === 'success' ? String(symbol.result) : ''),
      description: overlay?.description || '',
      image,
      banner,
      creator,
      creatorRewardsWallet:
        (payout.status === 'success' ? String(payout.result) : '') || creator,
      maxSupply: Number.isFinite(supplyN) ? supplyN : 0,
      maxPerWallet: maxPerWallet.status === 'success' ? Number(maxPerWallet.result) : 0,
      mintPriceUsdc: Number(formatUnits(priceRaw, 6)),
      publicStart: start.status === 'success' ? Number(start.result) * 1000 : 0,
      allowlist: root.status === 'success' && String(root.result) !== ZERO_ROOT,
      allowlistStart: alStart.status === 'success' ? Number(alStart.result) * 1000 : 0,
      allowlistEnd: alEnd.status === 'success' ? Number(alEnd.result) * 1000 : 0,
      revealed: revealed.status === 'success' ? Boolean(revealed.result) : false,
      royalty: Number.isFinite(royaltyAmt) ? Math.round(royaltyAmt) / 100 : 5,
      minted: Number.isFinite(mintedN) ? mintedN : 0,
      owners: 0,
      ...((snap) => ({
        floorUsdc: snap.floorUsdc,
        listed: snap.listed,
        volume24hUsdc: snap.volume24hUsdc,
        topOfferUsdc: snap.topOfferUsdc,
      }))(await getSnapshot(address)),
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

/** Factory scan only. Callers that paint Studio should use listCollections(). */
export async function fetchPortCollectionsLive(): Promise<Collection[]> {
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
    return withPublicSlugs(rows.filter((c): c is Collection => !!c))
  } catch {
    return []
  }
}

export async function listCollections(): Promise<Collection[]> {
  if (!arcPortEnabled()) return []
  const { getPortHomeCatalog } = await import('./catalog-cache')
  return (await getPortHomeCatalog()).collections
}

export async function getCollection(id: string): Promise<Collection | undefined> {
  if (!arcPortEnabled()) return undefined
  const { getPortCatalogCollection, upsertPortCatalogCollection } = await import('./catalog-cache')
  if (isPlausibleEvmAddress(id)) {
    try {
      const client = arcPublicClient()
      const ok = await client.readContract({
        address: ARC.NFT_FACTORY,
        abi: PORT_FACTORY_ABI,
        functionName: 'isCollection',
        args: [id as Address],
      })
      if (ok) {
        const row = await loadOne(id as Address)
        if (row) {
          await upsertPortCatalogCollection(row)
          return row
        }
      }
    } catch {
      /* fall through to last-good snapshot */
    }
  }
  return (await getPortCatalogCollection(id)) ?? undefined
}

function nftFrom(
  collection: Collection,
  id: number,
  meta?: { imageUrl?: string; name?: string; traits?: { type: string; value: string }[] } | null,
  owner = '',
): NftItem {
  const minted = id <= collection.minted
  if (!collection.revealed) {
    return {
      collection: collection.address,
      id,
      name: `${collection.name} #${id}`,
      image: collection.image,
      owner,
      minted,
      traits: [],
    }
  }
  return {
    collection: collection.address,
    id,
    name: meta?.name || `${collection.name} #${id}`,
    image: meta?.imageUrl || collection.image,
    owner,
    minted,
    traits: meta?.traits?.filter((t) => t.type && t.value) ?? [],
  }
}

export function itemsFor(collection: Collection): NftItem[] {
  return Array.from({ length: collection.minted }, (_, i) => nftFrom(collection, i + 1))
}

export async function getItems(id: string): Promise<NftItem[]> {
  const collection = await getCollection(id)
  if (!collection) return []
  if (!collection.revealed) {
    return Array.from({ length: collection.minted }, (_, i) => nftFrom(collection, i + 1))
  }
  const store = await getPortItems(collection.address)
  const ids = new Set<number>()
  for (let i = 1; i <= collection.minted; i++) ids.add(i)
  const cap = Math.max(collection.maxSupply, collection.minted, 0)
  for (const key of Object.keys(store.items)) {
    const nid = Number(key)
    if (!Number.isInteger(nid) || nid < 1) continue
    if (cap > 0 && nid > cap) continue
    ids.add(nid)
  }
  return [...ids]
    .sort((a, b) => a - b)
    .map((tokenId) => nftFrom(collection, tokenId, store.items[String(tokenId)]))
}

/** Unique owners among minted tokens. Caps at 400 reads. 0 means none or the scan failed. */
export async function countOwners(address: string, minted: number): Promise<number> {
  if (!isPlausibleEvmAddress(address) || minted <= 0) return 0
  const n = Math.min(minted, MAX_LIST)
  try {
    const reads = await arcPublicClient().multicall({
      allowFailure: true,
      contracts: Array.from({ length: n }, (_, i) => ({
        address: address as Address,
        abi: PORT_NFT_ABI,
        functionName: 'ownerOf' as const,
        args: [BigInt(i + 1)] as const,
      })),
    })
    const set = new Set<string>()
    for (const row of reads) {
      if (row.status === 'success') set.add(String(row.result).toLowerCase())
    }
    return set.size
  } catch {
    return 0
  }
}

export async function getItem(id: string, tokenId: number): Promise<NftItem | undefined> {
  const collection = await getCollection(id)
  if (!collection || !Number.isInteger(tokenId) || tokenId < 1 || tokenId > collection.minted) return undefined
  const meta = await getPortItem(collection.address, tokenId)
  let owner = ''
  try {
    owner = (await arcPublicClient().readContract({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    })) as string
  } catch {
    owner = ''
  }
  return nftFrom(collection, tokenId, meta, owner)
}
