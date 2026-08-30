import Link from 'next/link'
import type { NftItem } from '@/lib/port/types'
import { formatUsdc } from '@/lib/port/format'
import { cdnImage } from '@/lib/cdn-image'

export function NftCard({
  item,
  address,
  onClick,
}: {
  item: NftItem
  address: string
  onClick?: () => void
}) {
  const minted = item.minted !== false
  const body = (
    <>
      <div className="aspect-square overflow-hidden rounded-[24px] bg-s1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={cdnImage(item.image, 320)}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      </div>
      <div className="mt-2 truncate text-[13px] font-medium tracking-tightish text-t2">{item.name}</div>
      {item.listPriceUsdc != null ? (
        <div className="text-[13px] font-semibold tabular-nums">{formatUsdc(item.listPriceUsdc)} USDC</div>
      ) : minted ? null : (
        <div className="text-[11px] text-t3">Not minted</div>
      )}
    </>
  )
  if (!minted) {
    return <div className="min-w-0">{body}</div>
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group block min-w-0 w-full text-left text-white hover:text-white"
      >
        {body}
      </button>
    )
  }
  return (
    <Link href={`/studio/${address}/${item.id}`} className="group block min-w-0 text-white hover:text-white">
      {body}
    </Link>
  )
}
