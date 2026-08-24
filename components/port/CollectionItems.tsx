'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, SlidersHorizontal } from 'lucide-react'
import { NftCard } from '@/components/port/NftCard'
import { PortSheet } from '@/components/port/PortSheet'
import type { Collection, NftItem } from '@/lib/port/types'
import { formatInt } from '@/lib/port/format'
import { cn } from '@/lib/cn'

const PAGE = 24

export function CollectionItems({
  collection,
  items,
  isCreator,
  ownedIds = [],
  onListSelected,
}: {
  collection: Collection
  items: NftItem[]
  isCreator: boolean
  ownedIds?: number[]
  onListSelected?: (items: NftItem[]) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'minted' | 'listed'>('all')
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [sort, setSort] = useState<'id-asc' | 'id-desc' | 'price-asc' | 'price-desc'>('id-asc')
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [pickedIds, setPickedIds] = useState<number[]>([])

  const listedN = items.filter((i) => i.listPriceUsdc != null).length
  const mintedN = items.filter((i) => i.minted !== false).length
  const traitGroups = useMemo(() => {
    const groups = new Map<string, Map<string, number>>()
    for (const item of items) {
      for (const t of item.traits) {
        if (!t.type || !t.value) continue
        if (!groups.has(t.type)) groups.set(t.type, new Map())
        const bucket = groups.get(t.type)!
        bucket.set(t.value, (bucket.get(t.value) ?? 0) + 1)
      }
    }
    return [...groups.entries()]
      .map(([type, values]) => ({
        type,
        values: [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      }))
      .sort((a, b) => a.type.localeCompare(b.type))
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = items.filter((item) => {
      if (status === 'minted' && item.minted === false) return false
      if (status === 'listed' && item.listPriceUsdc == null) return false
      if (q) {
        const hay = `${item.name} #${item.id}`.toLowerCase()
        if (!hay.includes(q) && !String(item.id).includes(q)) return false
      }
      for (const [type, values] of Object.entries(picked)) {
        if (!values.length) continue
        const ok = item.traits.some((t) => t.type === type && values.includes(t.value))
        if (!ok) return false
      }
      return true
    })
    rows.sort((a, b) => {
      if (sort === 'id-desc') return b.id - a.id
      if (sort === 'price-asc' || sort === 'price-desc') {
        const ap = a.listPriceUsdc
        const bp = b.listPriceUsdc
        if (ap == null && bp == null) return a.id - b.id
        if (ap == null) return 1
        if (bp == null) return -1
        return sort === 'price-asc' ? ap - bp : bp - ap
      }
      return a.id - b.id
    })
    return rows
  }, [items, query, status, picked, sort])

  const visible = filtered.slice(0, page * PAGE)
  const pickedCount = Object.values(picked).reduce((n, v) => n + v.length, 0)
  const filterOn = Boolean(query.trim() || status !== 'all' || pickedCount)

  function toggleTrait(type: string, value: string) {
    setPage(1)
    setPicked((prev) => {
      const cur = prev[type] || []
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
      const copy = { ...prev }
      if (next.length) copy[type] = next
      else delete copy[type]
      return copy
    })
  }

  const filterBody = (
    <div className="space-y-5 pb-4">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t3" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
          placeholder="Search by name or #"
          className="h-11 w-full rounded-xl border border-hair bg-s2 pl-9 pr-3 text-[13px] outline-none placeholder:text-t3 focus:border-lime-line"
        />
      </label>

      {items.some((i) => i.minted !== false) ? (
        <div>
          <div className="text-[13px] font-medium text-t3">Status</div>
          <div className="mt-2 space-y-1">
            {(
              [
                ['all', 'All', items.length],
                ['listed', 'Listed', listedN],
                ['minted', 'Minted', mintedN],
              ] as const
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setStatus(key)
                  setPage(1)
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px]',
                  status === key ? 'bg-s2 text-white' : 'text-t2 hover:bg-s2',
                )}
              >
                {label}
                <span className="tabular-nums text-t3">{formatInt(n)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {traitGroups.map((group) => (
        <details key={group.type} open className="group/trait">
          <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-[13px] font-medium text-t3 [&::-webkit-details-marker]:hidden">
            {group.type}
            <span className="tabular-nums">{group.values.length}</span>
          </summary>
          <div className="mt-1 space-y-1">
            {group.values.map(([value, n]) => {
              const on = (picked[group.type] || []).includes(value)
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleTrait(group.type, value)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px]',
                    on ? 'bg-s2 text-white' : 'text-t2 hover:bg-s2',
                  )}
                >
                  {value}
                  <span className="tabular-nums text-t3">{formatInt(n)}</span>
                </button>
              )
            })}
          </div>
        </details>
      ))}
    </div>
  )

  if (items.length === 0) {
    return (
      <div className="mt-10">
        <h2 className="text-[17px] font-semibold tracking-tightish">Items</h2>
        <div className="mt-5 overflow-hidden rounded-[28px] border border-hair bg-s1 px-5 py-10 text-center sm:px-6 sm:py-14">
          <SetPreviewFan src={collection.image} side={collection.banner || collection.image} />
          <h3 className="mt-5 text-[20px] font-semibold tracking-display sm:text-[26px]">
            {isCreator ? 'Add the set' : "Art isn't in yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-t2">
            {isCreator
              ? 'Upload pieces in mint order. They show here as a preview.'
              : "The creator hasn't uploaded this set yet."}
          </p>
          {isCreator ? (
            <Link
              href={`/studio/${collection.address}/items`}
              className="mt-6 inline-flex h-12 items-center rounded-xl bg-lime px-5 text-[14px] font-semibold text-white hover:bg-lime-2"
            >
              Upload items
            </Link>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tightish">Items</h2>
        <div className="flex items-center gap-2">
          {ownedIds.length > 0 && onListSelected ? (
            <>
              {selecting ? (
                <button
                  type="button"
                  onClick={() =>
                    setPickedIds(
                      filtered
                        .filter((i) => i.minted !== false && ownedIds.includes(i.id))
                        .map((i) => i.id),
                    )
                  }
                  className="inline-flex h-11 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold"
                >
                  Select all
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setSelecting((s) => !s)
                  setPickedIds([])
                }}
                className="inline-flex h-11 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold"
              >
                {selecting ? 'Cancel' : 'Select'}
              </button>
            </>
          ) : null}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as 'id-asc' | 'id-desc' | 'price-asc' | 'price-desc')
              setPage(1)
            }}
            className="hidden h-11 rounded-xl border border-hair bg-s2 px-3 text-[13px] font-semibold text-white outline-none sm:block"
          >
            <option value="id-asc">ID low to high</option>
            <option value="id-desc">ID high to low</option>
            <option value="price-asc">Price low to high</option>
            <option value="price-desc">Price high to low</option>
          </select>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-hair bg-s2 px-3 text-[13px] font-semibold lg:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {filterOn ? <span className="h-1.5 w-1.5 rounded-full bg-lime" /> : null}
          </button>
        </div>
      </div>

      <div className="mt-5 flex gap-8">
        <aside className="hidden w-[240px] shrink-0 lg:block">
          {filterBody}
        </aside>
        <div className="min-w-0 flex-1">
          <label className="relative mb-4 block lg:hidden">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t3" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="Search by name or #"
              className="h-11 w-full rounded-xl border border-hair bg-s2 pl-9 pr-3 text-[13px] outline-none placeholder:text-t3 focus:border-lime-line"
            />
          </label>
          <div className="mb-4 flex items-center justify-between gap-3 sm:hidden">
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as 'id-asc' | 'id-desc' | 'price-asc' | 'price-desc')
                setPage(1)
              }}
              className="h-11 rounded-xl border border-hair bg-s2 px-3 text-[13px] font-semibold"
            >
              <option value="id-asc">ID low to high</option>
              <option value="id-desc">ID high to low</option>
              <option value="price-asc">Price low to high</option>
              <option value="price-desc">Price high to low</option>
            </select>
            <span className="text-[13px] tabular-nums text-t3">{formatInt(filtered.length)} items</span>
          </div>
          <p className="mb-4 hidden text-[13px] tabular-nums text-t3 sm:block">
            {formatInt(filtered.length)} items
          </p>
          {filtered.length === 0 ? (
            <div className="rounded-[24px] border border-hair bg-s1 px-6 py-16 text-center">
              <p className="text-[17px] font-semibold tracking-tightish">No items match</p>
              <p className="mt-2 text-[15px] text-t3">Clear filters to see the set.</p>
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  setStatus('all')
                  setPicked({})
                  setPage(1)
                }}
                className="mt-5 inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[13px] font-semibold"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-3">
                {visible.map((item) => {
                  const mine = ownedIds.includes(item.id)
                  const on = pickedIds.includes(item.id)
                  return (
                    <div key={item.id} className="relative">
                      {selecting && mine ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPickedIds((ids) =>
                              on ? ids.filter((x) => x !== item.id) : [...ids, item.id],
                            )
                          }
                          className={cn(
                            'absolute left-2 top-2 z-10 h-7 w-7 rounded-lg border text-[13px] font-bold',
                            on ? 'border-lime-line bg-lime text-white' : 'border-hair bg-s1/90 text-t3',
                          )}
                          aria-label={on ? 'Deselect' : 'Select'}
                        >
                          {on ? '✓' : ''}
                        </button>
                      ) : null}
                      <NftCard
                        item={item}
                        address={collection.address}
                        onClick={
                          selecting && mine
                            ? () =>
                                setPickedIds((ids) =>
                                  on ? ids.filter((x) => x !== item.id) : [...ids, item.id],
                                )
                            : undefined
                        }
                      />
                    </div>
                  )
                })}
              </div>
              {selecting && pickedIds.length > 0 && onListSelected ? (
                <div className="pointer-events-none fixed inset-x-0 bottom-[5.5rem] z-40 px-4 lg:static lg:bottom-auto lg:z-auto lg:mt-6 lg:px-0">
                  <button
                    type="button"
                    onClick={() => {
                      onListSelected(items.filter((i) => pickedIds.includes(i.id)))
                      setSelecting(false)
                      setPickedIds([])
                    }}
                    className="pointer-events-auto w-full rounded-xl bg-lime py-3 text-[14px] font-semibold text-white shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
                  >
                    List {pickedIds.length} item{pickedIds.length === 1 ? '' : 's'}
                  </button>
                </div>
              ) : null}
              {filtered.length > visible.length ? (
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  className="mt-6 w-full rounded-xl border border-hair py-3 text-[13px] font-semibold text-t2 hover:text-white"
                >
                  Show more ({formatInt(filtered.length - visible.length)} left)
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <PortSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        {filterBody}
      </PortSheet>
    </div>
  )
}

function SetPreviewFan({ src, side }: { src: string; side: string }) {
  return (
    <div className="relative mx-auto h-[132px] w-[200px] sm:h-[168px] sm:w-[240px]" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={side}
        alt=""
        className="absolute left-1 top-6 h-[92px] w-[92px] -rotate-[16deg] rounded-2xl object-cover shadow-[0_18px_40px_rgba(0,0,0,0.45)] ring-1 ring-white/10 sm:left-2 sm:top-8 sm:h-[112px] sm:w-[112px]"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={side}
        alt=""
        className="absolute right-1 top-6 h-[92px] w-[92px] rotate-[14deg] rounded-2xl object-cover shadow-[0_18px_40px_rgba(0,0,0,0.45)] ring-1 ring-white/10 sm:right-2 sm:top-8 sm:h-[112px] sm:w-[112px]"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="absolute left-1/2 top-0 h-[108px] w-[108px] -translate-x-1/2 rounded-2xl object-cover shadow-[0_20px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/15 sm:top-1 sm:h-[132px] sm:w-[132px]"
      />
    </div>
  )
}
