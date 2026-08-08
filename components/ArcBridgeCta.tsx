'use client'

/**
 * Compact "need USDC?" note. The upstream Robinpad component (`components/ArcBridgeCta.tsx`)
 * links this to `/bridge` — a whole CCTP Instant-OTC desk product this fork deliberately doesn't
 * ship (see README: "Instant launch only" scope). Rewritten as a static pointer to an external
 * on-ramp instead of a dead internal link. Same props/name as upstream so
 * `components/ArcDexTradePanel.tsx` (kept verbatim) needed zero edits.
 */
export function ArcBridgeCta({
  compact = false,
  reason = 'Need USDC on Arc?',
}: {
  compact?: boolean
  reason?: string
}) {
  if (compact) {
    return <span className="text-[11px] text-gray-500">Bridge USDC to Arc via Circle CCTP or an exchange.</span>
  }

  return (
    <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2.5">
      <p className="text-xs font-semibold text-sky-200">{reason}</p>
      <p className="text-[11px] text-gray-500 mt-0.5">
        Bring USDC to Arc mainnet (chain 5042) via Circle CCTP or any exchange that supports Arc withdrawals,
        then come back to trade.
      </p>
    </div>
  )
}
