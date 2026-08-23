import Link from 'next/link'
import { collectionStatus, type Collection } from '@/lib/port/types'
import { formatInt } from '@/lib/port/format'
import { Price } from './Price'

export function CollectionCard({ collection }: { collection: Collection }) {
  const status = collectionStatus(collection)
  return (
    <Link
      href={`/port/${collection.address}`}
      className="group block min-w-0 text-white hover:text-white"
    >
      <div className="aspect-square overflow-hidden rounded-[24px] bg-s1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={collection.image}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tightish">{collection.name}</div>
          <div className="mt-0.5 text-[13px] tabular-nums text-t3">
            {formatInt(collection.minted)} / {formatInt(collection.maxSupply)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {status === 'sold' ? (
            <span className="text-[13px] font-medium text-t3">Sold out</span>
          ) : (
            <Price value={collection.mintPriceUsdc} />
          )}
        </div>
      </div>
    </Link>
  )
}
