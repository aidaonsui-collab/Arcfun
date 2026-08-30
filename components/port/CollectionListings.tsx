'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import type { Collection, NftItem } from '@/lib/port/types'
import { isListing, sortByPriceAsc, sortByPriceDesc, type Listing } from '@/lib/port/listings'
import { atomicToUsdc } from '@/lib/port/market'
import { formatUsdc, shortAddr, timeUntil } from '@/lib/port/format'
import { studioPath } from '@/lib/port/path'
import { CancelOrderButton } from './CancelOrderButton'
import { cdnImage } from '@/lib/cdn-image'

function itemFor(collection: Collection, items: NftItem[], tokenId: string): NftItem | undefined {
  const id = Number(tokenId)
  return items.find((i) => i.id === id)
}

function expiryLabel(endTime: string) {
  const ms = Number(endTime) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms <= Date.now()) return 'Expired'
  return timeUntil(ms)
}

export function CollectionListings({
  collection,
  items,
  listings,
  onBuy,
  onChanged,
}: {
  collection: Collection
  items: NftItem[]
  listings: Listing[]
  onBuy: (listing: Listing) => void
  onChanged: () => void
}) {
  const { address } = useAccount()
  const rows = sortByPriceAsc(listings.filter(isListing))

  if (rows.length === 0) {
    return (
      <div className="mt-5 overflow-hidden rounded-[24px] border border-hair bg-s1 px-5 py-14 text-center">
        <p className="text-[17px] font-semibold tracking-tightish">No listings</p>
        <p className="mt-2 text-[15px] text-t2">Live asks show here, cheapest first.</p>
      </div>
    )
  }

  return (
    <div className="mt-5 overflow-hidden rounded-[24px] border border-hair bg-s1">
      <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_auto] gap-3 border-b border-hair2 px-4 py-2.5 text-[12px] font-medium text-t3 sm:grid">
        <div>Item</div>
        <div className="text-right">Price</div>
        <div>Seller</div>
        <div>Expires</div>
        <div />
      </div>
      <div className="divide-y divide-hair2">
        {rows.map((row) => {
          const item = itemFor(collection, items, row.tokenId)
          const mine = Boolean(address && address.toLowerCase() === row.offerer.toLowerCase())
          const href = studioPath(collection, row.tokenId)
          const name = item?.name || `${collection.name} #${row.tokenId}`
          const image = item?.image || collection.image
          const price = formatUsdc(atomicToUsdc(row.priceAtomic), 4)
          return (
            <div
              key={row.orderHash}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_auto]"
            >
              <Link href={href} className="flex min-w-0 items-center gap-3 text-white hover:text-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cdnImage(image, 44)} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                <span className="truncate text-[14px] font-semibold">{name}</span>
              </Link>
              <div className="text-right text-[14px] font-semibold tabular-nums sm:text-right">
                {price} <span className="font-medium text-t3">USDC</span>
              </div>
              <div className="col-span-2 hidden text-[13px] text-t3 sm:col-span-1 sm:block">{shortAddr(row.offerer)}</div>
              <div className="hidden text-[13px] text-t3 sm:block">{expiryLabel(row.endTime)}</div>
              <div className="flex justify-end">
                {mine ? (
                  <CancelOrderButton order={row} onDone={onChanged} />
                ) : (
                  <button
                    type="button"
                    onClick={() => onBuy(row)}
                    className="h-10 rounded-xl bg-lime px-4 text-[13px] font-semibold text-white"
                  >
                    Buy
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function CollectionOffers({
  collection,
  items,
  offers,
  ownedIds,
  onAccept,
  onChanged,
}: {
  collection: Collection
  items: NftItem[]
  offers: Listing[]
  ownedIds: number[]
  onAccept: (offer: Listing) => void
  onChanged: () => void
}) {
  const { address } = useAccount()
  const rows = sortByPriceDesc(offers.filter((o) => o.kind === 'offer' || o.kind === 'collection-offer'))

  if (rows.length === 0) {
    return (
      <div className="mt-5 overflow-hidden rounded-[24px] border border-hair bg-s1 px-5 py-14 text-center">
        <p className="text-[17px] font-semibold tracking-tightish">No offers</p>
        <p className="mt-2 text-[15px] text-t2">Item bids and collection-wide offers show here.</p>
      </div>
    )
  }

  return (
    <div className="mt-5 overflow-hidden rounded-[24px] border border-hair bg-s1">
      <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_auto] gap-3 border-b border-hair2 px-4 py-2.5 text-[12px] font-medium text-t3 sm:grid">
        <div>Item</div>
        <div className="text-right">Offer</div>
        <div>From</div>
        <div>Expires</div>
        <div />
      </div>
      <div className="divide-y divide-hair2">
        {rows.map((row) => {
          const wide = row.kind === 'collection-offer'
          const item = wide ? undefined : itemFor(collection, items, row.tokenId)
          const mine = Boolean(address && address.toLowerCase() === row.offerer.toLowerCase())
          const name = wide ? 'Any item' : item?.name || `${collection.name} #${row.tokenId}`
          const image = item?.image || collection.image
          const href = wide ? studioPath(collection) : studioPath(collection, row.tokenId)
          const canAccept = ownedIds.length > 0 && (wide || ownedIds.includes(Number(row.tokenId)))
          return (
            <div
              key={row.orderHash}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_auto]"
            >
              <Link href={href} className="flex min-w-0 items-center gap-3 text-white hover:text-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cdnImage(image, 44)} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                <span className="truncate text-[14px] font-semibold">{name}</span>
              </Link>
              <div className="text-right text-[14px] font-semibold tabular-nums">
                {formatUsdc(atomicToUsdc(row.priceAtomic), 4)} <span className="font-medium text-t3">USDC</span>
              </div>
              <div className="hidden text-[13px] text-t3 sm:block">{shortAddr(row.offerer)}</div>
              <div className="hidden text-[13px] text-t3 sm:block">{expiryLabel(row.endTime)}</div>
              <div className="flex justify-end">
                {mine ? (
                  <CancelOrderButton order={row} onDone={onChanged} />
                ) : canAccept ? (
                  <button
                    type="button"
                    onClick={() => onAccept(row)}
                    className="h-10 rounded-xl bg-lime px-4 text-[13px] font-semibold text-white"
                  >
                    Accept
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
