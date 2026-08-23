'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { SlidersHorizontal } from 'lucide-react'
import { CreatorChip } from '@/components/port/CreatorChip'
import { NftCard } from '@/components/port/NftCard'
import { Price } from '@/components/port/Price'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyMintBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { PortSheet } from '@/components/port/PortSheet'
import { collectionStatus, type Collection, type NftItem } from '@/lib/port/types'
import { formatInt, timeUntil } from '@/lib/port/format'
import { cn } from '@/lib/cn'

export function CollectionView({
  collection,
  items,
}: {
  collection: Collection
  items: NftItem[]
}) {
  const [trait, setTrait] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [mintOpen, setMintOpen] = useState(false)

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
        <div className="aspect-video w-full overflow-hidden bg-s1 sm:mx-auto sm:mt-6 sm:max-w-desk sm:rounded-[28px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={collection.banner || collection.image}
            alt=""
            className="h-full w-full object-cover rise-in"
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-desk px-4 pb-28 sm:px-10 lg:pb-16">
        <div className="rise-in-2 -mt-8 flex items-end gap-4 sm:-mt-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={collection.image}
            alt=""
            className="h-20 w-20 rounded-2xl object-cover shadow-[0_0_0_1px_rgba(255,255,255,0.08)] sm:h-24 sm:w-24"
          />
          <div className="min-w-0 pb-1">
            <h1 className="truncate text-[28px] font-semibold tracking-display sm:text-[40px]">
              {collection.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CreatorChip address={collection.creator} name={collection.creatorName} />
              <RoyaltyLine royalty={collection.royalty} />
            </div>
          </div>
        </div>

        {collection.description ? (
          <p className="mt-5 max-w-xl text-[15px] text-t2">{collection.description}</p>
        ) : null}
        {collection.allowlist ? (
          <p className="mt-2 text-[13px] text-lime-t">Allowlist mint</p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[24px] bg-hair sm:grid-cols-4">
          <Stat label="Items" value={formatInt(collection.maxSupply)} />
          <Stat label="Minted" value={formatInt(collection.minted)} />
          <Stat label="Owners" value={formatInt(collection.owners)} />
          <Stat label="Price" valueNode={<Price value={collection.mintPriceUsdc} />} />
        </div>

        <div className="mt-6 hidden lg:block">
          <button
            type="button"
            disabled={status !== 'live'}
            onClick={() => setMintOpen(true)}
            className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
          >
            {mintLabel}
          </button>
        </div>

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
      <PortSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Traits">
        {filterBody}
      </PortSheet>
    </>
  )
}

function Stat({
  label,
  value,
  valueNode,
}: {
  label: string
  value?: string
  valueNode?: ReactNode
}) {
  return (
    <div className="bg-s1 px-4 py-3">
      <div className="text-[13px] text-t3">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums tracking-tightish">
        {valueNode ?? value}
      </div>
    </div>
  )
}
