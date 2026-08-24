'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { CreatorChip } from '@/components/port/CreatorChip'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { Price } from '@/components/port/Price'
import { RoyaltyLine } from '@/components/port/RoyaltyLine'
import { StickyMintBar } from '@/components/port/StickyMintBar'
import { MintSheet } from '@/components/port/MintSheet'
import { collectionStatus, type Collection, type NftItem } from '@/lib/port/types'
import { shortAddr, timeUntil } from '@/lib/port/format'

export function ItemView({ collection, item }: { collection: Collection; item: NftItem }) {
  const { address: wallet } = useAccount()
  const [open, setOpen] = useState(false)
  const you = Boolean(wallet && item.owner.toLowerCase() === wallet.toLowerCase())
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
              <div className="text-[13px] text-t3">Mint price</div>
              <Price value={collection.mintPriceUsdc} size="lg" />
            </div>
            <div className="mt-8 hidden lg:block">
              <button
                type="button"
                disabled={status !== 'live'}
                onClick={() => setOpen(true)}
                className="inline-flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
              >
                {mintLabel}
              </button>
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
            <p className="mt-2 text-[15px] tracking-tightish">
              {you ? 'You' : shortAddr(item.owner)}
            </p>

            <h2 className="mt-10 text-[13px] font-medium text-t3">Activity</h2>
            <div className="mt-3 rounded-[24px] border border-hair bg-s1 px-4 py-10 text-center text-[15px] text-t3">
              No activity yet
            </div>
          </div>
        </div>
      </div>
      <StickyMintBar collection={collection} onMint={() => setOpen(true)} />
      <MintSheet collection={collection} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
