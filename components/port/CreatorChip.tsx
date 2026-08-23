import { shortAddr } from '@/lib/port/format'

export function CreatorChip({ address, name }: { address: string; name?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-hair bg-s2 py-1 pl-1 pr-3">
      <span className="grid h-6 w-6 place-items-center rounded-full bg-s3 text-[10px] font-semibold text-lime-t">
        {(name ?? address).slice(0, 1).toUpperCase()}
      </span>
      <span className="text-[13px] font-medium tracking-tightish">
        {name ?? shortAddr(address)}
      </span>
    </span>
  )
}
