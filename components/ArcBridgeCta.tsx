'use client'

/**
 * Compact "need USDC?" note — points at Arc OTC (Instant OTC desk).
 */
import Link from 'next/link'

export function ArcBridgeCta({
  compact = false,
  reason = 'Need USDC on Arc?',
}: {
  compact?: boolean
  reason?: string
}) {
  if (compact) {
    return (
      <span className="text-[11px] text-t3">
        Get USDC via{' '}
        <Link href="/otc" className="text-lime-t hover:underline">
          Arc OTC
        </Link>
        .
      </span>
    )
  }

  return (
    <div className="rounded-[18px] border border-lime-line bg-lime-soft px-3 py-2.5">
      <p className="text-xs font-semibold text-lime-t">{reason}</p>
      <p className="text-[11px] text-t2 mt-0.5 leading-relaxed">
        Buy Arc USDC with Base or Arbitrum USDC on{' '}
        <Link href="/otc" className="text-lime-t font-semibold hover:underline">
          Arc OTC
        </Link>
        — escrowed desk (not Circle CCTP).
      </p>
    </div>
  )
}
