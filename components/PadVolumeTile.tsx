'use client'

import { fmtUsd } from '@/lib/ui-format'

/** Pad-wide 24h and lifetime volume. Zeros if the indexer has not stamped a window yet. */
export function PadVolumeTile({
  volume24h,
  volumeAll,
  className = '',
}: {
  volume24h: number
  volumeAll: number
  className?: string
}) {
  const v24 = Number.isFinite(volume24h) ? volume24h : 0
  const vall = Number.isFinite(volumeAll) ? volumeAll : 0

  return (
    <div
      className={`inline-flex items-stretch rounded-[14px] border border-hair bg-s2 overflow-hidden ${className}`}
      title="Indexed Uniswap volume across Arcfun launches"
    >
      <div className="px-3.5 py-2 min-w-[5.5rem]">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">24h vol</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tightish text-white">
          {fmtUsd(v24)}
        </div>
      </div>
      <div className="w-px self-stretch bg-hair" />
      <div className="px-3.5 py-2 min-w-[5.5rem]">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">All time</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tightish text-white">
          {fmtUsd(vall)}
        </div>
      </div>
    </div>
  )
}
