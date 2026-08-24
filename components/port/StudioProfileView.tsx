'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAccount, useConnect } from 'wagmi'
import { Loader2 } from 'lucide-react'
import type { StudioProfile } from '@/lib/port/studio-profile'
import { formatInt, formatUsdc, shortAddr } from '@/lib/port/format'
import { fetchListings, isListing, sortByPriceDesc, type Listing } from '@/lib/port/listings'
import { OfficialBadge } from './OfficialBadge'
import { NftCard } from './NftCard'
import { Price } from './Price'
import { ListSheet } from './ListSheet'
import { BatchListSheet } from './BatchListSheet'
import { TransferSheet } from './TransferSheet'
import { AcceptOfferSheet } from './AcceptOfferSheet'
import { studioPath } from '@/lib/port/path'
import type { Collection, NftItem } from '@/lib/port/types'

export function StudioProfileView({ address }: { address?: string }) {
  const { address: connected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const target = (address || connected || '').toLowerCase()
  const mine = Boolean(connected && target && connected.toLowerCase() === target)

  const [profile, setProfile] = useState<StudioProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [book, setBook] = useState<Listing[]>([])
  const [listItem, setListItem] = useState<{ collection: Collection; item: NftItem } | null>(null)
  const [sendItem, setSendItem] = useState<NftItem | null>(null)
  const [accept, setAccept] = useState<{ offer: Listing; tokenId: number } | null>(null)
  const [batch, setBatch] = useState<{ collection: Collection; items: NftItem[] } | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [pickedIds, setPickedIds] = useState<number[]>([])

  useEffect(() => {
    if (!target) {
      setLoading(false)
      setProfile(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/port/profile/${target}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (!d?.ok || !d.profile) {
          setError(d?.error || 'Could not load studio profile')
          setProfile(null)
          return
        }
        setError('')
        setProfile(d.profile as StudioProfile)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target])

  useEffect(() => {
    const cols = profile?.heldCollections || []
    if (cols.length === 0) {
      setBook([])
      return
    }
    let cancelled = false
    void Promise.all(cols.map((c) => fetchListings(c.address))).then((rows) => {
      if (!cancelled) setBook(rows.flat())
    })
    return () => {
      cancelled = true
    }
  }, [profile])

  const groups = useMemo(() => {
    if (!profile) return []
    const by = new Map<string, { collection: Collection; items: NftItem[] }>()
    for (const col of profile.heldCollections || []) {
      by.set(col.address.toLowerCase(), { collection: col, items: [] })
    }
    for (const item of profile.held) {
      const g = by.get(item.collection.toLowerCase())
      if (g) g.items.push(item)
    }
    return [...by.values()].filter((g) => g.items.length > 0)
  }, [profile])

  function listingFor(item: NftItem) {
    return (
      book.find(
        (l) =>
          isListing(l) &&
          l.collection.toLowerCase() === item.collection.toLowerCase() &&
          l.tokenId === String(item.id),
      ) ?? null
    )
  }

  function bestOfferFor(item: NftItem) {
    const rows = book.filter(
      (l) =>
        l.collection.toLowerCase() === item.collection.toLowerCase() &&
        (l.kind === 'offer' || l.kind === 'collection-offer') &&
        (l.kind === 'collection-offer' || l.tokenId === String(item.id)),
    )
    return sortByPriceDesc(rows)[0] ?? null
  }

  function reloadBook() {
    const cols = profile?.heldCollections || []
    void Promise.all(cols.map((c) => fetchListings(c.address))).then((rows) => setBook(rows.flat()))
  }

  if (!target) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-[28px] font-semibold tracking-display">Your studio</h1>
        <p className="mt-2 text-[15px] text-t2">Connect to see collections you launched, mint earnings, and items you hold.</p>
        <button
          type="button"
          disabled={isPending}
          onClick={() => connect({ connector: connectors[0] })}
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-lime px-5 text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
        >
          {isPending ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-lime-t" />
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="px-4 py-24 text-center text-t2">
        {error || 'Profile not found'}
      </div>
    )
  }

  const name = profile.meta.displayName || shortAddr(profile.address)
  const avatar = profile.meta.avatarUrl

  return (
    <div className="mx-auto w-full max-w-desk px-4 pb-20 pt-8 sm:px-10 sm:pt-10">
      <div className="flex flex-wrap items-end gap-4">
        <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-2xl border border-hair bg-s2 sm:h-20 sm:w-20">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[18px] font-semibold text-t3">{name.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <div className="min-w-0 pb-1">
          <h1 className="text-[28px] font-semibold tracking-display sm:text-[32px]">{name}</h1>
          <p className="mt-1 font-mono text-[13px] text-t3">{shortAddr(profile.address)}</p>
        </div>
        {mine ? (
          <Link
            href={`/creator/${profile.address}`}
            className="ml-auto inline-flex h-10 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold text-t2 hover:text-white"
          >
            Edit profile
          </Link>
        ) : null}
      </div>

      <div className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-[24px] bg-hair">
        <Stat label="Launched" value={formatInt(profile.launched.length)} />
        <Stat label="Held" value={formatInt(profile.held.length)} />
        <Stat label="Primary earned" value={`${formatUsdc(profile.primaryEarnedUsdc)} USDC`} />
      </div>
      <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-t3">
        Primary mint pays 95% to the creator as items mint. List, accept offers, or send from Held.
        Secondary royalties settle on Seaport when an item resells.
      </p>

      <section className="mt-10">
        <h2 className="text-[21px] font-semibold tracking-tightish">Launched</h2>
        {profile.launched.length === 0 ? (
          <p className="mt-3 text-[15px] text-t3">
            No collections yet.{' '}
            {mine ? (
              <Link href="/studio/create" className="font-semibold text-lime-t hover:text-white">
                Create one
              </Link>
            ) : null}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-[24px] border border-hair bg-s1">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-hair2 text-[11px] font-semibold uppercase tracking-[0.08em] text-t3">
                  <th className="px-4 py-3 text-left font-semibold sm:px-5">Collection</th>
                  <th className="px-4 py-3 text-right font-semibold sm:px-5">Royalty</th>
                  <th className="px-4 py-3 text-right font-semibold sm:px-5">Minted</th>
                  <th className="px-4 py-3 text-right font-semibold sm:px-5">Earned</th>
                </tr>
              </thead>
              <tbody>
                {profile.launched.map((row) => (
                  <tr key={row.collection.address} className="border-b border-hair2 last:border-0">
                    <td className="px-4 py-3 sm:px-5">
                      <Link
                        href={studioPath(row.collection)}
                        className="flex items-center gap-3 text-white hover:text-white"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={row.collection.image}
                          alt=""
                          className="h-9 w-9 rounded-xl object-cover"
                        />
                        <span className="flex items-center gap-1.5">
                          <span className="font-semibold tracking-tightish">{row.collection.name}</span>
                          {row.collection.originToken ? (
                            <OfficialBadge symbol={row.collection.originSymbol} size="sm" label={false} />
                          ) : null}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right text-[13px] tabular-nums text-t2 sm:px-5">
                      {row.collection.royalty}%
                    </td>
                    <td className="px-4 py-3 text-right text-[13px] tabular-nums text-t2 sm:px-5">
                      {formatInt(row.collection.minted)}/{formatInt(row.collection.maxSupply)}
                    </td>
                    <td className="px-4 py-3 text-right sm:px-5">
                      <div className="flex items-center justify-end gap-3">
                        <Price value={row.primaryEarnedUsdc} />
                        {mine ? (
                          <Link
                            href={studioPath(row.collection, 'items')}
                            className="text-[13px] font-semibold text-lime-t hover:text-white"
                          >
                            Items
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-[21px] font-semibold tracking-tightish">Held</h2>
        {profile.held.length === 0 ? (
          <p className="mt-3 text-[15px] text-t3">No ArcStudio items in this wallet.</p>
        ) : (
          <div className="mt-6 space-y-10">
            {groups.map((group) => {
              const colKey = group.collection.address.toLowerCase()
              const selectingHere = selecting === colKey
              return (
                <div key={group.collection.address}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link
                      href={studioPath(group.collection)}
                      className="text-[15px] font-semibold text-white hover:text-white"
                    >
                      {group.collection.name}
                    </Link>
                    {mine ? (
                      <div className="flex items-center gap-2">
                        {selectingHere ? (
                          <button
                            type="button"
                            onClick={() =>
                              setPickedIds(group.items.map((i) => i.id))
                            }
                            className="inline-flex h-10 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold"
                          >
                            Select all
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            setSelecting(selectingHere ? null : colKey)
                            setPickedIds([])
                          }}
                          className="inline-flex h-10 items-center rounded-xl border border-hair px-3 text-[13px] font-semibold"
                        >
                          {selectingHere ? 'Cancel' : 'Select'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {group.items.map((item) => {
                      const listed = listingFor(item)
                      const offer = mine ? bestOfferFor(item) : null
                      const priced = listed
                        ? { ...item, listPriceUsdc: Number(listed.priceAtomic) / 1e6 }
                        : item
                      const on = pickedIds.includes(item.id)
                      return (
                        <div key={`${item.collection}-${item.id}`}>
                          <NftCard
                            item={priced}
                            address={group.collection.slug || group.collection.address}
                            onClick={
                              selectingHere
                                ? () =>
                                    setPickedIds((ids) =>
                                      on ? ids.filter((x) => x !== item.id) : [...ids, item.id],
                                    )
                                : undefined
                            }
                          />
                          {mine && !selectingHere ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => setListItem({ collection: group.collection, item })}
                                className="h-9 rounded-lg border border-hair px-2.5 text-[12px] font-semibold"
                              >
                                {listed ? 'Listed' : 'List'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setSendItem(item)}
                                className="h-9 rounded-lg border border-hair px-2.5 text-[12px] font-semibold"
                              >
                                Send
                              </button>
                              {offer ? (
                                <button
                                  type="button"
                                  onClick={() => setAccept({ offer, tokenId: item.id })}
                                  className="h-9 rounded-lg bg-lime px-2.5 text-[12px] font-semibold text-white"
                                >
                                  Accept
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                  {mine && selectingHere && pickedIds.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setBatch({
                          collection: group.collection,
                          items: group.items.filter((i) => pickedIds.includes(i.id)),
                        })
                        setSelecting(null)
                        setPickedIds([])
                      }}
                      className="mt-4 w-full rounded-xl bg-lime py-3 text-[14px] font-semibold text-white"
                    >
                      List {pickedIds.length} item{pickedIds.length === 1 ? '' : 's'}
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {listItem ? (
        <ListSheet
          collection={listItem.collection}
          item={listItem.item}
          listing={listingFor(listItem.item)}
          open
          onClose={() => {
            setListItem(null)
            reloadBook()
          }}
        />
      ) : null}
      {sendItem ? (
        <TransferSheet
          item={sendItem}
          listing={listingFor(sendItem)}
          open
          onClose={() => {
            setSendItem(null)
            reloadBook()
          }}
        />
      ) : null}
      <AcceptOfferSheet
        offer={accept?.offer ?? null}
        tokenId={accept?.tokenId || 1}
        open={!!accept}
        onClose={() => {
          setAccept(null)
          reloadBook()
        }}
      />
      {batch ? (
        <BatchListSheet
          collection={batch.collection}
          items={batch.items}
          open
          onClose={() => {
            setBatch(null)
            reloadBook()
          }}
        />
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-s1 px-4 py-3">
      <div className="text-[13px] text-t3">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums tracking-tightish">{value}</div>
    </div>
  )
}
