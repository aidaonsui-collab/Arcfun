'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { Pencil } from 'lucide-react'
import { CreatorChip } from '@/components/port/CreatorChip'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyMintBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { EditBannerSheet } from '@/components/port/EditBannerSheet'
import { CollectionItems } from '@/components/port/CollectionItems'
import { collectionStatus, type Collection, type NftItem } from '@/lib/port/types'
import { formatInt, formatUsdc, timeUntil } from '@/lib/port/format'

export function CollectionView({
  collection,
  items,
}: {
  collection: Collection
  items: NftItem[]
}) {
  const { address } = useAccount()
  const [mintOpen, setMintOpen] = useState(false)
  const [bannerEdit, setBannerEdit] = useState(false)
  const [banner, setBanner] = useState(collection.banner)
  const isCreator = Boolean(
    address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase(),
  )

  const status = collectionStatus(collection)
  const mintLabel =
    status === 'sold'
      ? 'Sold out'
      : status === 'soon'
        ? `Starts in ${timeUntil(collection.publicStart)}`
        : 'Mint'

  return (
    <>
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
              {banner ? 'Edit banner' : 'Add banner'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-desk px-4 pb-28 sm:px-10 lg:pb-16">
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
              <HeroStat label="Price" value={formatUsdc(collection.mintPriceUsdc)} suffix="USDC" />
              <HeroStat label="Minted" value={formatInt(collection.minted)} />
              <HeroStat label="Items" value={formatInt(collection.maxSupply)} />
              <HeroStat label="Owners" value={formatInt(collection.owners)} />
            </div>
          </div>
        </div>
        {collection.description ? (
          <p className="mt-5 max-w-xl text-[15px] text-t2">{collection.description}</p>
        ) : null}
        {collection.allowlist ? (
          <p className="mt-2 text-[13px] text-lime-t">Allowlist mint</p>
        ) : null}

        <div className="mt-6 hidden items-center gap-3 lg:flex">
          <button
            type="button"
            disabled={status !== 'live'}
            onClick={() => setMintOpen(true)}
            className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
          >
            {mintLabel}
          </button>
          {isCreator ? (
            <Link
              href={`/studio/${collection.address}/items`}
              className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
            >
              Upload items
            </Link>
          ) : null}
        </div>

        {isCreator ? (
          <div className="mt-4 lg:hidden">
            <Link
              href={`/studio/${collection.address}/items`}
              className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
            >
              Upload items
            </Link>
          </div>
        ) : null}

        <CollectionItems collection={collection} items={items} isCreator={isCreator} />
      </div>
      <StickyMintBar collection={collection} onMint={() => setMintOpen(true)} />
      <MintSheet collection={collection} open={mintOpen} onClose={() => setMintOpen(false)} />
      <EditBannerSheet
        collection={collection.address}
        currentBanner={banner}
        open={bannerEdit}
        onClose={() => setBannerEdit(false)}
        onSaved={(url) => {
          setBanner(url)
          setBannerEdit(false)
        }}
      />
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
