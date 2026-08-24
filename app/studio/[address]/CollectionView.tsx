'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { Pencil, SlidersHorizontal } from 'lucide-react'
import { CreatorChip } from '@/components/port/CreatorChip'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { NftCard } from '@/components/port/NftCard'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyMintBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { PortSheet } from '@/components/port/PortSheet'
import { EditBannerSheet } from '@/components/port/EditBannerSheet'
import { collectionStatus, type Collection, type NftItem } from '@/lib/port/types'
import { formatInt, formatUsdc, timeUntil } from '@/lib/port/format'
import { cn } from '@/lib/cn'

export function CollectionView({
  collection,
  items,
}: {
  collection: Collection
  items: NftItem[]
}) {
  const { address } = useAccount()
  const [trait, setTrait] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [mintOpen, setMintOpen] = useState(false)
  const [bannerEdit, setBannerEdit] = useState(false)
  const [banner, setBanner] = useState(collection.banner)
  const isCreator =
    !!address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase()

  const traits = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of items) {
      for (const t of item.traits) {
        const key = `${t.type}: ${t.value}`
        map.set(key, (map.get(key) ?? 0) + 1)
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const filtered = trait
    ? items.filter((i) => i.traits.some((t) => `${t.type}: ${t.value}` === trait))
    : items
  const visible = showAll ? filtered : filtered.slice(0, 24)
  const status = collectionStatus(collection)
  const mintLabel =
    status === 'sold'
      ? 'Sold out'
      : status === 'soon'
        ? `Starts in ${timeUntil(collection.publicStart)}`
        : 'Mint'

  const filterBody = (
    <div className="space-y-1 pb-4">
      <button
        type="button"
        onClick={() => setTrait(null)}
        className={cn(
          'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px]',
          !trait ? 'bg-s2 text-white' : 'text-t2 hover:bg-s2',
        )}
      >
        All items
        <span className="tabular-nums text-t3">{items.length}</span>
      </button>
      {traits.map(([key, n]) => (
        <button
          key={key}
          type="button"
          onClick={() => setTrait(key === trait ? null : key)}
          className={cn(
            'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px]',
            trait === key ? 'bg-s2 text-white' : 'text-t2 hover:bg-s2',
          )}
        >
          {key}
          <span className="tabular-nums text-t3">{n}</span>
        </button>
      ))}
    </div>
  )

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

        <div className="mt-10 flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-tightish">Items</h2>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-hair bg-s2 px-3 text-[13px] font-semibold lg:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Traits
          </button>
        </div>

        <div className="mt-5 flex gap-8">
          {traits.length > 0 ? (
            <aside className="hidden w-[220px] shrink-0 lg:block">
              <div className="text-[13px] font-medium text-t3">Traits</div>
              <div className="mt-3">{filterBody}</div>
            </aside>
          ) : null}
          <div className="min-w-0 flex-1">
            {filtered.length === 0 ? (
              <div className="rounded-[24px] border border-hair bg-s1 px-6 py-16 text-center">
                <p className="text-[17px] font-semibold tracking-tightish">
                  {items.length === 0 ? 'Nothing minted yet' : 'No items with that trait'}
                </p>
                <p className="mt-2 text-[15px] text-t3">
                  {status === 'soon'
                    ? `Public mint starts in ${timeUntil(collection.publicStart)}`
                    : 'Mint to see items here.'}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-3">
                  {visible.map((item) => (
                    <NftCard key={item.id} item={item} address={collection.address} />
                  ))}
                </div>
                {filtered.length > visible.length ? (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="mt-6 w-full rounded-xl border border-hair py-3 text-[13px] font-semibold text-t2 hover:text-white"
                  >
                    Show all {filtered.length}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
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
      <PortSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Traits">
        {filterBody}
      </PortSheet>
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
