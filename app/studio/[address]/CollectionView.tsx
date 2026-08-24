'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient } from 'wagmi'
import { Pencil } from 'lucide-react'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import type { Address } from 'viem'
import { CreatorChip } from '@/components/port/CreatorChip'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyMintBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { EditBannerSheet } from '@/components/port/EditBannerSheet'
import { CollectionItems } from '@/components/port/CollectionItems'
import { MarketActivityList } from '@/components/port/MarketActivityList'
import { OfferSheet } from '@/components/port/OfferSheet'
import { AcceptOfferSheet } from '@/components/port/AcceptOfferSheet'
import { BatchListSheet } from '@/components/port/BatchListSheet'
import { CancelOrderButton } from '@/components/port/CancelOrderButton'
import { SweepSheet } from '@/components/port/SweepSheet'
import { fetchListings, isListing, sortByPriceDesc, type Listing } from '@/lib/port/listings'
import { atomicToUsdc, type MarketActivity } from '@/lib/port/market'
import { studioPath } from '@/lib/port/path'
import { collectionStatus, mintCta, type Collection, type NftItem } from '@/lib/port/types'
import { formatInt, formatUsdc, shortAddr } from '@/lib/port/format'
import { DropLanding } from '@/components/port/DropLanding'
import { DropSettingsSheet } from '@/components/port/DropSettingsSheet'

const EMPTY_LISTINGS: Listing[] = []

export function CollectionView({
  collection,
  items,
  activity = [],
  listings: listingsProp = EMPTY_LISTINGS,
}: {
  collection: Collection
  items: NftItem[]
  activity?: MarketActivity[]
  listings?: Listing[]
}) {
  const router = useRouter()
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [mintOpen, setMintOpen] = useState(false)
  const [bannerEdit, setBannerEdit] = useState(false)
  const [banner, setBanner] = useState(collection.banner)
  const [offerOpen, setOfferOpen] = useState(false)
  const [batchItems, setBatchItems] = useState<NftItem[] | null>(null)
  const [ownedIds, setOwnedIds] = useState<number[]>([])
  const [colOffers, setColOffers] = useState<Listing[]>([])
  const [listings, setListings] = useState<Listing[]>(listingsProp)
  const [accept, setAccept] = useState<Listing | null>(null)
  const [sweepOpen, setSweepOpen] = useState(false)
  const [dropSettings, setDropSettings] = useState(false)
  const [description, setDescription] = useState(collection.description)
  const [twitter, setTwitter] = useState(collection.twitter || '')
  const [telegram, setTelegram] = useState(collection.telegram || '')
  const [website, setWebsite] = useState(collection.website || '')
  const isCreator = Boolean(
    address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase(),
  )

  useEffect(() => {
    void fetchListings(collection.address, undefined, 'collection-offer').then((rows) =>
      setColOffers(sortByPriceDesc(rows)),
    )
  }, [collection.address])

  useEffect(() => {
    setListings(listingsProp)
  }, [listingsProp])

  useEffect(() => {
    const minted = items.filter((i) => i.minted !== false).slice(0, 200)
    if (!address || !publicClient || minted.length === 0) {
      setOwnedIds([])
      return
    }
    void publicClient
      .multicall({
        allowFailure: true,
        contracts: minted.map((i) => ({
          address: collection.address as Address,
          abi: PORT_NFT_ABI,
          functionName: 'ownerOf' as const,
          args: [BigInt(i.id)] as const,
        })),
      })
      .then((rows) => {
        setOwnedIds(
          minted
            .filter((_, i) => {
              const r = rows[i]
              return r.status === 'success' && String(r.result).toLowerCase() === address.toLowerCase()
            })
            .map((i) => i.id),
        )
      })
      .catch(() => setOwnedIds([]))
  }, [address, items, collection.address, publicClient])

  const status = collectionStatus(collection)
  const mintLabel = mintCta(collection)
  const page = { ...collection, description, twitter, telegram, website, banner }

  const drop = !collection.revealed

  return (
    <>
      {drop ? (
        <div className="mx-auto flex w-full max-w-desk items-center justify-end px-4 pt-6 sm:px-10">
          {isCreator ? (
            <button
              type="button"
              onClick={() => setBannerEdit(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hair bg-s1 px-3 text-[13px] font-semibold text-white hover:border-lime-line"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit page
            </button>
          ) : null}
        </div>
      ) : (
      <div className="relative">
        <div className="relative h-[200px] w-full overflow-hidden bg-s1 sm:mx-auto sm:mt-6 sm:h-[260px] sm:max-w-desk sm:rounded-[28px] lg:h-[300px]">
          {banner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={banner} alt="" className="h-full w-full object-cover rise-in" />
          ) : (
            <div className="h-full w-full bg-[radial-gradient(ellipse_at_top,rgba(47,132,219,0.18),transparent_60%)]" />
          )}
          {isCreator ? (
            <button
              type="button"
              onClick={() => setBannerEdit(true)}
              className="absolute right-3 top-3 z-20 inline-flex h-9 items-center gap-1.5 rounded-full border border-hair bg-[rgba(10,15,24,0.78)] px-3 text-[13px] font-semibold text-white backdrop-blur-md hover:border-lime-line"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit page
            </button>
          ) : null}
        </div>
      </div>
      )}
      <div className={`mx-auto w-full max-w-desk px-4 pb-28 sm:px-10 lg:pb-16 ${drop ? 'pt-2' : ''}`}>
        {!drop ? (
        <div className="relative z-10 -mt-10 flex flex-col gap-5 sm:-mt-12 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
          <div className="flex min-w-0 items-end gap-3 sm:gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={collection.image}
              alt=""
              className="h-20 w-20 shrink-0 rounded-2xl object-cover shadow-[0_0_0_1px_rgba(255,255,255,0.12)] ring-4 ring-[var(--bg)] sm:h-24 sm:w-24"
            />
            <div className="min-w-0 pb-0.5">
              <h1 className="flex min-w-0 items-center gap-2 text-[24px] font-semibold tracking-display sm:text-[32px]">
                <span className="truncate">{collection.name}</span>
                {collection.originToken ? (
                  <OfficialBadge
                    symbol={collection.originSymbol}
                    href={`/token/${collection.originToken}`}
                    size="md"
                    label={false}
                  />
                ) : null}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <CreatorChip address={collection.creator} name={collection.creatorName} />
                <RoyaltyLine royalty={collection.royalty} />
              </div>
            </div>
          </div>
          <div className="-mx-4 overflow-x-auto scrollbar-none px-4 lg:mx-0 lg:overflow-visible lg:px-0">
            <div className="flex min-w-max items-end lg:justify-end">
              <HeroStat
                label="Floor"
                value={collection.floorUsdc != null ? formatUsdc(collection.floorUsdc) : '—'}
                suffix={collection.floorUsdc != null ? 'USDC' : undefined}
              />
              <HeroStat
                label="Top offer"
                value={collection.topOfferUsdc != null ? formatUsdc(collection.topOfferUsdc) : '—'}
                suffix={collection.topOfferUsdc != null ? 'USDC' : undefined}
              />
              <HeroStat label="Listed" value={formatInt(collection.listed ?? 0)} />
              <HeroStat
                label="Owners"
                value={
                  collection.owners > 0
                    ? formatInt(collection.owners)
                    : collection.minted > 0
                      ? '—'
                      : '0'
                }
              />
              <HeroStat
                label="24h vol"
                value={formatUsdc(collection.volume24hUsdc ?? 0)}
                suffix="USDC"
              />
            </div>
          </div>
        </div>
        ) : null}
        {description ? (
          <p className="mt-5 max-w-xl text-[15px] text-t2">{description}</p>
        ) : null}
        {collection.allowlist ? (
          <p className="mt-2 text-[13px] text-lime-t">Allowlist mint</p>
        ) : null}

        {collection.revealed ? (
        <>
        <div className="mt-6 hidden items-center gap-3 lg:flex">
          <button
            type="button"
            disabled={status !== 'live'}
            onClick={() => setMintOpen(true)}
            className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
          >
            {mintLabel}
          </button>
          <button
            type="button"
            onClick={() => setOfferOpen(true)}
            className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
          >
            Collection offer
          </button>
          {listings.length > 0 ? (
            <button
              type="button"
              onClick={() => setSweepOpen(true)}
              className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
            >
              Sweep
            </button>
          ) : null}
          {isCreator ? (
            <>
              <button
                type="button"
                onClick={() => setDropSettings(true)}
                className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
              >
                Drop settings
              </button>
              <Link
                href={studioPath(collection, 'items')}
                className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
              >
                Upload items
              </Link>
            </>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOfferOpen(true)}
            className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
          >
            Collection offer
          </button>
          {listings.length > 0 ? (
            <button
              type="button"
              onClick={() => setSweepOpen(true)}
              className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
            >
              Sweep
            </button>
          ) : null}
          {isCreator ? (
            <>
              <button
                type="button"
                onClick={() => setDropSettings(true)}
                className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
              >
                Drop settings
              </button>
              <Link
                href={studioPath(collection, 'items')}
                className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
              >
                Upload items
              </Link>
            </>
          ) : null}
        </div>
        </>
        ) : null}

        {collection.revealed ? (
          <CollectionItems
            collection={collection}
            items={items}
            isCreator={isCreator}
            ownedIds={ownedIds}
            onListSelected={setBatchItems}
          />
        ) : (
          <DropLanding
            collection={page}
            isCreator={isCreator}
            onMint={() => setMintOpen(true)}
            onSettings={() => setDropSettings(true)}
          />
        )}

        {collection.revealed && colOffers.length > 0 ? (
          <div className="mt-10">
            <h2 className="text-[17px] font-semibold tracking-tightish">Collection offers</h2>
            <div className="mt-4 divide-y divide-hair2 overflow-hidden rounded-[24px] border border-hair bg-s1">
              {colOffers.map((o) => (
                <div key={o.orderHash} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="text-[14px] font-semibold tabular-nums">
                      {formatUsdc(atomicToUsdc(o.priceAtomic))} USDC
                    </div>
                    <div className="text-[13px] text-t3">{shortAddr(o.offerer)}</div>
                  </div>
                  {address && o.offerer.toLowerCase() === address.toLowerCase() ? (
                    <CancelOrderButton
                      order={o}
                      onDone={() =>
                        void fetchListings(collection.address, undefined, 'collection-offer').then((rows) =>
                          setColOffers(sortByPriceDesc(rows)),
                        )
                      }
                    />
                  ) : ownedIds.length > 0 ? (
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
          </div>
        ) : null}

        <div className="mt-10">
          <h2 className="text-[17px] font-semibold tracking-tightish">Activity</h2>
          <div className="mt-4">
            <MarketActivityList
              events={activity}
              collection={collection.slug || collection.address}
              pollCollection={collection.address}
            />
          </div>
        </div>
      </div>
      <StickyMintBar collection={collection} onMint={() => setMintOpen(true)} />
      <MintSheet collection={collection} open={mintOpen} onClose={() => setMintOpen(false)} />
      <SweepSheet
        listings={listings}
        open={sweepOpen}
        onClose={() => {
          setSweepOpen(false)
          void fetchListings(collection.address, undefined, 'listing').then((rows) =>
            setListings(rows.filter(isListing)),
          )
        }}
      />
      <OfferSheet
        collection={collection}
        open={offerOpen}
        onClose={() => {
          setOfferOpen(false)
          void fetchListings(collection.address, undefined, 'collection-offer').then((rows) =>
            setColOffers(sortByPriceDesc(rows)),
          )
        }}
      />
      <BatchListSheet
        collection={collection}
        items={batchItems || []}
        open={!!batchItems}
        onClose={() => setBatchItems(null)}
      />
      <AcceptOfferSheet
        offer={accept}
        tokenId={ownedIds[0] || 1}
        ownedIds={ownedIds}
        open={!!accept}
        onClose={() => {
          setAccept(null)
          void fetchListings(collection.address, undefined, 'collection-offer').then((rows) =>
            setColOffers(sortByPriceDesc(rows)),
          )
          router.refresh()
        }}
      />
      <EditBannerSheet
        collection={page}
        currentBanner={banner}
        open={bannerEdit}
        onClose={() => setBannerEdit(false)}
        onSaved={(patch) => {
          setBanner(patch.bannerUrl)
          if (patch.description !== undefined) setDescription(patch.description)
          if (patch.twitter !== undefined) setTwitter(patch.twitter)
          if (patch.telegram !== undefined) setTelegram(patch.telegram)
          if (patch.website !== undefined) setWebsite(patch.website)
          setBannerEdit(false)
        }}
      />
      <DropSettingsSheet collection={page} open={dropSettings} onClose={() => setDropSettings(false)} />
    </>
  )
}

function HeroStat({
  label,
  value,
  suffix,
}: {
  label: string
  value: string
  suffix?: string
}) {
  return (
    <div className="min-w-[4.75rem] shrink-0 border-l border-hair px-4 first:border-l-0 first:pl-0 sm:min-w-[5.5rem] sm:px-5 sm:first:pl-0">
      <div className="text-[12px] text-t3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1 text-[16px] font-semibold tabular-nums tracking-tightish sm:text-[18px]">
        {value}
        {suffix ? <span className="text-[12px] font-medium text-t3">{suffix}</span> : null}
      </div>
    </div>
  )
}
