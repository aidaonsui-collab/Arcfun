'use client'

/**
 * Compact "need USDC?" note — static pointer to external on-ramp (no in-app CCTP desk).
 */
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
        Bridge USDC to Arc via Circle CCTP or an exchange.
      </span>
    )
  }

  return (
    <div className="rounded-[18px] border border-lime-line bg-lime-soft px-3 py-2.5">
      <p className="text-xs font-semibold text-lime-t">{reason}</p>
      <p className="text-[11px] text-t2 mt-0.5 leading-relaxed">
        Bring USDC to Arc mainnet (chain 5042) via Circle CCTP or any exchange that supports Arc
        withdrawals, then come back to trade.
      </p>
    </div>
  )
}
