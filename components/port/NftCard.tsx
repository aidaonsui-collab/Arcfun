import Link from 'next/link'
import type { NftItem } from '@/lib/port/types'

export function NftCard({ item, address }: { item: NftItem; address: string }) {
  return (
    <Link
      href={`/studio/${address}/${item.id}`}
      className="group block min-w-0 text-white hover:text-white"
    >
      <div className="aspect-square overflow-hidden rounded-[24px] bg-s1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.image}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      </div>
      <div className="mt-2 truncate text-[13px] font-medium tracking-tightish text-t2">#{item.id}</div>
    </Link>
  )
}
