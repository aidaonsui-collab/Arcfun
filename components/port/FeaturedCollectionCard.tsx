import Link from 'next/link'
import { collectionStatus, type Collection } from '@/lib/port/types'
import { formatInt } from '@/lib/port/format'
import { OfficialBadge } from './OfficialBadge'
import { Price } from './Price'

export function FeaturedCollectionCard({ collection }: { collection: Collection }) {
  const status = collectionStatus(collection)
  const art = collection.banner || collection.image
  return (
    <Link
      href={`/studio/${collection.address}`}
      className="group relative block h-[220px] w-[min(100%,320px)] shrink-0 overflow-hidden rounded-[24px] text-white hover:text-white sm:h-[240px] sm:w-[360px]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={art}
        alt=""
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
      />
      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
      <span className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[18px] font-semibold tracking-tightish sm:text-[20px]">
            {collection.name}
          </span>
          {collection.originToken ? (
            <OfficialBadge symbol={collection.originSymbol} size="sm" label={false} />
          ) : null}
        </span>
        <span className="mt-1.5 flex items-baseline gap-2 text-[14px] text-white/80">
          {status === 'sold' ? (
            <span>Sold out</span>
          ) : (
            <>
              <span className="text-white/55">{collection.floorUsdc != null ? 'Floor' : 'Mint'}</span>
              <Price
                value={collection.floorUsdc != null ? collection.floorUsdc : collection.mintPriceUsdc}
                className="text-white"
              />
            </>
          )}
          <span className="text-white/40">·</span>
          <span className="tabular-nums text-white/55">
            {formatInt(collection.minted)}/{formatInt(collection.maxSupply)}
          </span>
        </span>
      </span>
    </Link>
  )
}
