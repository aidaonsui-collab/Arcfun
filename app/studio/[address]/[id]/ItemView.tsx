'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { CreatorChip } from '@/components/port/CreatorChip'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { Price } from '@/components/port/Price'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyItemBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { ListSheet } from '@/components/port/ListSheet'
import { BuySheet } from '@/components/port/BuySheet'
import { OfferSheet } from '@/components/port/OfferSheet'
import { AcceptOfferSheet } from '@/components/port/AcceptOfferSheet'
import { TransferSheet } from '@/components/port/TransferSheet'
import { MarketActivityList } from '@/components/port/MarketActivityList'
import { CancelOrderButton } from '@/components/port/CancelOrderButton'
import { fetchActivity, fetchListings, sortByPriceDesc, type Listing } from '@/lib/port/listings'
import { atomicToUsdc } from '@/lib/port/market'
import type { MarketActivity } from '@/lib/port/market'
import { collectionStatus, type Collection, type NftItem } from '@/lib/port/types'
import { formatUsdc, shortAddr, timeUntil } from '@/lib/port/format'

export function ItemView({
  collection,
  item,
  listing: listingProp = null,
  activity: activityProp = [],
}: {
  collection: Collection
  item: NftItem
  listing?: Listing | null
  activity?: MarketActivity[]
}) {
  const { address: wallet } = useAccount()
  const [open, setOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [buyOpen, setBuyOpen] = useState(false)
  const [listing, setListing] = useState<Listing | null>(listingProp)
  const [offers, setOffers] = useState<Listing[]>([])
  const [offerOpen, setOfferOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [accept, setAccept] = useState<Listing | null>(null)
  const [activity, setActivity] = useState<MarketActivity[]>(activityProp)
  const you = Boolean(wallet && item.owner.toLowerCase() === wallet.toLowerCase())

  const loadListing = useCallback(async () => {
    const [rows, bids, tape] = await Promise.all([
      fetchListings(collection.address, item.id, 'listing'),
      fetchListings(collection.address, item.id, 'offer'),
      fetchActivity(collection.address, item.id),
    ])
    setListing(rows[0] ?? null)
    setOffers(sortByPriceDesc(bids))
    setActivity(tape)
  }, [collection.address, item.id])

  useEffect(() => {
    setListing(listingProp)
  }, [listingProp])

  useEffect(() => {
    loadListing()
  }, [loadListing])

  const listedPrice = listing
    ? (Number(listing.priceAtomic) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })
    : null
  const status = collectionStatus(collection)
  const mintLabel =
    status === 'sold'
      ? 'Sold out'
      : status === 'soon'
        ? `Starts in ${timeUntil(collection.publicStart)}`
        : 'Mint'

  return (
    <>
      <div className="mx-auto w-full max-w-desk px-4 pb-28 pt-0 sm:px-10 lg:pb-16 lg:pt-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start">
          <div className="-mx-4 overflow-hidden bg-s1 sm:mx-0 sm:rounded-[24px] lg:sticky lg:top-24">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.image}
              alt={item.name}
              className="aspect-square w-full object-cover rise-in"
            />
          </div>
          <div className="rise-in-2">
            <Link
              href={`/studio/${collection.address}`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-t3 hover:text-t2"
            >
              {collection.name}
              {collection.originToken ? (
                <OfficialBadge symbol={collection.originSymbol} size="sm" label={false} />
              ) : null}
            </Link>
            <h1 className="mt-2 text-[32px] font-semibold tracking-display sm:text-[40px]">
              {item.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <CreatorChip address={item.owner} name={you ? 'You' : undefined} />
              <RoyaltyLine royalty={collection.royalty} />
              {collection.originToken ? (
                <OfficialBadge
                  symbol={collection.originSymbol}
                  href={`/token/${collection.originToken}`}
                />
              ) : null}
            </div>
            <div className="mt-6">
              {listing ? (
                <>
                  <div className="text-[13px] text-t3">Listed for</div>
                  <Price value={Number(listing.priceAtomic) / 1e6} size="lg" />
                </>
              ) : item.minted ? (
                offers[0] ? (
                  <>
                    <div className="text-[13px] text-t3">Best offer</div>
                    <Price value={atomicToUsdc(offers[0].priceAtomic)} size="lg" />
                  </>
                ) : (
                  <div className="text-[17px] font-semibold tracking-tightish">Not listed</div>
                )
              ) : (
                <>
                  <div className="text-[13px] text-t3">Mint price</div>
                  <Price value={collection.mintPriceUsdc} size="lg" />
                </>
              )}
            </div>
            <div className="mt-8 hidden gap-3 lg:flex">
              {item.minted && you ? (
                <>
                  <button
                    type="button"
                    onClick={() => setListOpen(true)}
                    className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white"
                  >
                    {listing ? 'Update listing' : 'List for sale'}
                  </button>
                  {listing ? (
                    <button
                      type="button"
                      onClick={() => setListOpen(true)}
                      className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
                    >
                      Cancel
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setSendOpen(true)}
                    className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
                  >
                    Send
                  </button>
                </>
              ) : listing ? (
                <>
                  <button
                    type="button"
                    onClick={() => setBuyOpen(true)}
                    className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white"
                  >
                    Buy for {listedPrice} USDC
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfferOpen(true)}
                    className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
                  >
                    Make offer
                  </button>
                </>
              ) : item.minted ? (
                <button
                  type="button"
                  onClick={() => setOfferOpen(true)}
                  className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white"
                >
                  Make offer
                </button>
              ) : (
                <button
                  type="button"
                  disabled={status !== 'live'}
                  onClick={() => setOpen(true)}
                  className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
                >
                  {mintLabel}
                </button>
              )}
            </div>

            <h2 className="mt-10 text-[13px] font-medium text-t3">Traits</h2>
            {item.traits.length === 0 ? (
              <p className="mt-3 text-[15px] text-t3">No traits</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {item.traits.map((t) => (
                  <div key={`${t.type}:${t.value}`} className="rounded-xl border border-hair bg-s1 px-3 py-3">
                    <div className="text-[13px] text-t3">{t.type}</div>
                    <div className="mt-0.5 truncate text-[15px] font-semibold tracking-tightish">
                      {t.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h2 className="mt-10 text-[13px] font-medium text-t3">Owner</h2>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[15px] tracking-tightish">
                {you ? 'You' : shortAddr(item.owner)}
              </p>
              {you ? (
                <button
                  type="button"
                  onClick={() => setSendOpen(true)}
                  className="inline-flex h-10 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold lg:hidden"
                >
                  Send
                </button>
              ) : null}
            </div>

            {offers.length > 0 ? (
              <>
                <h2 className="mt-10 text-[13px] font-medium text-t3">Offers</h2>
                <div className="mt-3 divide-y divide-hair2 overflow-hidden rounded-[24px] border border-hair bg-s1">
                  {offers.map((o) => (
                    <div key={o.orderHash} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <div className="text-[14px] font-semibold tabular-nums">
                          {formatUsdc(atomicToUsdc(o.priceAtomic))} USDC
                        </div>
                        <div className="text-[13px] text-t3">
                          {o.kind === 'collection-offer' ? 'Collection · ' : ''}
                          {shortAddr(o.offerer)}
                        </div>
                      </div>
                      {wallet && o.offerer.toLowerCase() === wallet.toLowerCase() ? (
                        <CancelOrderButton order={o} onDone={loadListing} />
                      ) : you ? (
                        <button
                          type="button"
                          onClick={() => setAccept(o)}
                          className="h-10 rounded-xl bg-lime px-4 text-[13px] font-semibold text-white"
                        >
                          Accept
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <h2 className="mt-10 text-[13px] font-medium text-t3">Activity</h2>
            <div className="mt-3">
              <MarketActivityList events={activity} />
            </div>
          </div>
        </div>
      </div>
      <StickyItemBar
        priceUsdc={
          listing
            ? Number(listing.priceAtomic) / 1e6
            : item.minted
              ? offers[0]
                ? atomicToUsdc(offers[0].priceAtomic)
                : null
              : collection.mintPriceUsdc
        }
        priceLabel={
          listing
            ? 'Listed for'
            : item.minted
              ? you
                ? 'You own this'
                : offers[0]
                  ? 'Best offer'
                  : 'Unlisted'
              : 'Mint'
        }
        cta={
          item.minted && you
            ? listing
              ? 'Update listing'
              : 'List for sale'
            : listing
              ? `Buy for ${listedPrice} USDC`
              : item.minted
                ? 'Make offer'
                : mintLabel
        }
        disabled={
          item.minted && you
            ? false
            : listing
              ? false
              : item.minted
                ? false
                : status !== 'live'
        }
        onClick={() => {
          if (item.minted && you) setListOpen(true)
          else if (listing) setBuyOpen(true)
          else if (item.minted) setOfferOpen(true)
          else setOpen(true)
        }}
      />
      <MintSheet collection={collection} open={open} onClose={() => setOpen(false)} />
      <ListSheet
        collection={collection}
        item={item}
        listing={listing}
        open={listOpen}
        onClose={() => {
          setListOpen(false)
          loadListing()
        }}
      />
      <BuySheet
        listing={listing}
        open={buyOpen}
        onClose={() => {
          setBuyOpen(false)
          loadListing()
        }}
      />
      <TransferSheet
        item={item}
        listing={listing}
        open={sendOpen}
        onClose={() => {
          setSendOpen(false)
          loadListing()
        }}
      />
      <OfferSheet
        collection={collection}
        tokenId={item.id}
        open={offerOpen}
        onClose={() => {
          setOfferOpen(false)
          loadListing()
        }}
      />
      <AcceptOfferSheet
        offer={accept}
        tokenId={item.id}
        open={!!accept}
        onClose={() => {
          setAccept(null)
          loadListing()
        }}
      />
    </>
  )
}
