import Link from 'next/link'
import type { MarketActivity } from '@/lib/port/market'
import { atomicToUsdc } from '@/lib/port/market'
import { formatUsdc, timeAgo } from '@/lib/port/format'

const LABEL: Record<MarketActivity['type'], string> = {
  list: 'Listed',
  sale: 'Sold',
  cancel: 'Cancelled',
  offer: 'Offer',
}

export function MarketActivityList({
  events,
  collection,
  names,
  empty = 'No activity yet',
}: {
  events: MarketActivity[]
  collection?: string
  names?: Record<string, string>
  empty?: string
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-[24px] border border-hair bg-s1 px-4 py-10 text-center text-[15px] text-t3">
        {empty}
      </div>
    )
  }
  return (
    <div className="divide-y divide-hair2 overflow-hidden rounded-[24px] border border-hair bg-s1">
      {events.map((e) => {
        const col = collection || e.collection
        const href =
          col && e.tokenId !== '0'
            ? `/studio/${col}/${e.tokenId}`
            : col
              ? `/studio/${col}`
              : undefined
        const name = names?.[e.collection.toLowerCase()]
        const row = (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{LABEL[e.type]}</div>
              <div className="mt-0.5 truncate text-[13px] text-t3">
                {name ? `${name} · ` : ''}
                {e.tokenId === '0' ? 'Collection' : `#${e.tokenId}`}
                <span className="text-white/20"> · </span>
                {timeAgo(e.at)}
              </div>
            </div>
            <div className="shrink-0 text-[14px] font-semibold tabular-nums">
              {formatUsdc(atomicToUsdc(e.priceAtomic))} USDC
            </div>
          </div>
        )
        return href ? (
          <Link key={`${e.orderHash}:${e.type}:${e.at}`} href={href} className="block text-white hover:bg-s2/60 hover:text-white">
            {row}
          </Link>
        ) : (
          <div key={`${e.orderHash}:${e.type}:${e.at}`}>{row}</div>
        )
      })}
    </div>
  )
}
