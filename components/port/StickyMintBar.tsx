'use client'

import { collectionStatus, type Collection } from '@/lib/port/types'
import { timeUntil } from '@/lib/port/format'
import { Price } from './Price'

export function StickyMintBar({
  collection,
  onMint,
}: {
  collection: Collection
  onMint: () => void
}) {
  const status = collectionStatus(collection)
  const label =
    status === 'sold'
      ? 'Sold out'
      : status === 'soon'
        ? `Starts in ${timeUntil(collection.publicStart)}`
        : 'Mint'

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hair bg-[rgba(10,15,24,0.9)] backdrop-blur-xl lg:hidden">
      <div className="flex items-center gap-3 px-4 pt-3 pb-safe-cta">
        <div className="min-w-0">
          <div className="text-[13px] text-t3">
            {collection.floorUsdc != null ? 'Floor' : 'Mint'}
          </div>
          <Price
            value={collection.floorUsdc != null ? collection.floorUsdc : collection.mintPriceUsdc}
            size="lg"
          />
        </div>
        <button
          type="button"
          disabled={status !== 'live'}
          onClick={onMint}
          className="h-14 flex-1 rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {label}
        </button>
      </div>
    </div>
  )
}

export function StickyItemBar({
  priceUsdc,
  priceLabel,
  cta,
  disabled,
  onClick,
}: {
  priceUsdc: number | null
  priceLabel: string
  cta: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hair bg-[rgba(10,15,24,0.9)] backdrop-blur-xl lg:hidden">
      <div className="flex items-center gap-3 px-4 pt-3 pb-safe-cta">
        <div className="min-w-0">
          {priceUsdc == null ? (
            <div className="text-[17px] font-semibold tracking-tightish">{priceLabel}</div>
          ) : (
            <>
              <div className="text-[13px] text-t3">{priceLabel}</div>
              <Price value={priceUsdc} size="lg" />
            </>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          className="h-14 flex-1 rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {cta}
        </button>
      </div>
    </div>
  )
}
