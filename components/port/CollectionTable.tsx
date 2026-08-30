import Link from 'next/link'
import { studioPath } from '@/lib/port/path'
import { collectionStatus, type Collection } from '@/lib/port/types'
import { formatInt } from '@/lib/port/format'
import { OfficialBadge } from './OfficialBadge'
import { Price } from './Price'
import { cn } from '@/lib/cn'
import { cdnImage } from '@/lib/cdn-image'

const COLS = [
  { key: 'collection', label: 'Collection', align: 'left' },
  { key: 'floor', label: 'Floor', align: 'right' },
  { key: 'offer', label: 'Top offer', align: 'right' },
  { key: 'listed', label: 'Listed', align: 'right' },
  { key: 'vol', label: '24h vol', align: 'right' },
  { key: 'minted', label: 'Minted', align: 'right' },
] as const

export function CollectionTable({ collections }: { collections: Collection[] }) {
  return (
    <div className="overflow-x-auto rounded-[24px] border border-hair bg-s1">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-hair2 text-[11px] font-semibold uppercase tracking-[0.08em] text-t3">
            {COLS.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'px-4 py-3 font-semibold sm:px-5',
                  col.align === 'right' && 'text-right',
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {collections.map((c) => {
            const status = collectionStatus(c)
            return (
              <tr key={c.address} className="border-b border-hair2 last:border-0 hover:bg-s2/60">
                <td className="px-4 py-3 sm:px-5">
                  <Link
                    href={studioPath(c)}
                    className="flex min-w-0 items-center gap-3 text-white hover:text-white"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={cdnImage(c.image, 36)}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-xl object-cover shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                    />
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[14px] font-semibold tracking-tightish">
                        {c.name}
                      </span>
                      {c.originToken ? (
                        <OfficialBadge symbol={c.originSymbol} size="sm" label={false} />
                      ) : null}
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-right sm:px-5">
                  {status === 'sold' ? (
                    <span className="text-[13px] text-t3">Sold out</span>
                  ) : c.floorUsdc != null ? (
                    <Price value={c.floorUsdc} />
                  ) : (
                    <span className="text-[13px] text-t3">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right sm:px-5">
                  {c.topOfferUsdc != null ? (
                    <Price value={c.topOfferUsdc} />
                  ) : (
                    <span className="text-[13px] text-t3">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-t2 sm:px-5">
                  {formatInt(c.listed ?? 0)}
                </td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-t2 sm:px-5">
                  <Price value={c.volume24hUsdc ?? 0} />
                </td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-t2 sm:px-5">
                  {formatInt(c.minted)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
