import { collectionSlug } from './path'
import type { Collection } from './types'

export type PortCatalogSnapLike = {
  collections?: unknown
  at?: number
} | null | undefined

export function isUsablePortSnapshot(
  row: PortCatalogSnapLike,
): row is { collections: Collection[]; at: number } {
  return Boolean(row && Array.isArray(row.collections) && row.collections.length > 0 && row.at)
}

export function collectionFromOverlay(
  address: string,
  meta: {
    name?: string
    symbol?: string
    imageUrl?: string
    bannerUrl?: string
    description?: string
    twitter?: string
    telegram?: string
    website?: string
    creator?: string
    originToken?: string
  } | null | undefined,
  prev?: Collection | null,
  itemCount = 0,
): Collection {
  const name = meta?.name || prev?.name || 'Collection'
  const symbol = meta?.symbol || prev?.symbol || ''
  const image = meta?.imageUrl || prev?.image || ''
  const bannerRaw = meta?.bannerUrl || prev?.banner || ''
  const creator = meta?.creator || prev?.creator || ''
  const originToken = meta?.originToken || prev?.originToken
  // Item metadata is art/traits for token ids. It is not totalMinted and not maxSupply.
  // Using itemCount here marked eve "Sold out" at 100/100 while chain was 12/1000.
  const minted = Number(prev?.minted) || 0
  const maxSupply = Number(prev?.maxSupply) || 0
  return {
    address,
    slug: collectionSlug({ address, name, symbol }),
    name,
    symbol,
    description: meta?.description || prev?.description || '',
    image,
    banner: bannerRaw && bannerRaw !== image ? bannerRaw : prev?.banner || '',
    creator,
    creatorRewardsWallet: prev?.creatorRewardsWallet || creator,
    maxSupply,
    maxPerWallet: prev?.maxPerWallet ?? 0,
    mintPriceUsdc: prev?.mintPriceUsdc ?? 0,
    publicStart: prev?.publicStart ?? 0,
    allowlist: prev?.allowlist ?? false,
    allowlistStart: prev?.allowlistStart ?? 0,
    allowlistEnd: prev?.allowlistEnd ?? 0,
    revealed: prev?.revealed ?? itemCount > 0,
    royalty: prev?.royalty ?? 5,
    minted,
    owners: prev?.owners ?? 0,
    floorUsdc: prev?.floorUsdc,
    listed: prev?.listed,
    volume24hUsdc: prev?.volume24hUsdc,
    topOfferUsdc: prev?.topOfferUsdc,
    twitter: meta?.twitter ?? prev?.twitter,
    telegram: meta?.telegram ?? prev?.telegram,
    website: meta?.website ?? prev?.website,
    originToken,
    originSymbol:
      prev?.originSymbol ||
      (originToken?.toLowerCase() === '0x19209e55049bc613c5cc8b66b7df7824096e78cf' ? 'EVE' : undefined),
  }
}

/** Overlay/register rows often have maxSupply 0. Do not wipe last-good on-chain stats. */
export function mergePortCollection(prev: Collection | undefined, incoming: Collection): Collection {
  if (!prev) return incoming
  const hasSupply = (Number(incoming.maxSupply) || 0) > 0
  return {
    ...prev,
    ...incoming,
    maxSupply: hasSupply ? incoming.maxSupply : prev.maxSupply,
    minted: hasSupply ? incoming.minted : prev.minted,
    maxPerWallet: incoming.maxPerWallet || prev.maxPerWallet,
    mintPriceUsdc: hasSupply ? incoming.mintPriceUsdc : prev.mintPriceUsdc,
    publicStart: incoming.publicStart || prev.publicStart,
    allowlist: incoming.allowlist || prev.allowlist,
    allowlistStart: incoming.allowlistStart || prev.allowlistStart,
    allowlistEnd: incoming.allowlistEnd || prev.allowlistEnd,
    revealed: incoming.revealed || prev.revealed,
    royalty: incoming.royalty || prev.royalty,
    creatorRewardsWallet: incoming.creatorRewardsWallet || prev.creatorRewardsWallet,
    owners: incoming.owners || prev.owners,
  }
}

export function matchPortCollection(rows: Collection[], id: string): Collection | undefined {
  const key = (id || '').toLowerCase()
  if (!key) return undefined
  return rows.find(
    (c) =>
      c.address.toLowerCase() === key ||
      (c.slug || '').toLowerCase() === key ||
      (c.symbol || '').toLowerCase() === key ||
      (c.name || '').toLowerCase() === key,
  )
}
