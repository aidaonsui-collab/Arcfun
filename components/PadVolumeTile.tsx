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
      className={`inline-grid grid-cols-2 self-start rounded-[14px] border border-hair bg-s2 overflow-hidden ${className}`}
      title="Uniswap volume across Arcfun launches"
    >
      <div className="px-3.5 py-2 w-[7.25rem]">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">24h vol</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tightish text-white">
          {fmtUsd(v24)}
        </div>
      </div>
      <div className="px-3.5 py-2 w-[7.25rem] border-l border-hair">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">All time</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tightish text-white">
          {fmtUsd(vall)}
        </div>
      </div>
    </div>
  )
}
