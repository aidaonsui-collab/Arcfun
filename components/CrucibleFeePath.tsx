/**
 * Buy/Sell fee path on the token page (under the chart) and create preview.
 * Structure from Tolly Toll Flow (toggle + $ on buy legs + sell-to-dead) —
 * visual language from Arcfun: docs stacked bar + token-page 4-up tiles.
 * No pipes, no goblin.
 */
'use client'

import { useMemo, useState } from 'react'
import {
  CRUCIBLE_CONTRACTS_NOTE,
  fmtBpsPct,
  quoteFeeFromNotional,
  splitUsdcFee,
  usesLegacyOnChainSplits,
  type LaunchKind,
  type TradeSide,
} from '@/lib/crucible'
import { fmtUsd } from '@/lib/ui-format'

function fmtFeeUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(4)}`
  if (n > 0) return `$${n.toFixed(6)}`
  return '$0'
}

export function CrucibleFeePath({
  kind,
  notionalUsdc = 100,
  showSideToggle = true,
  className = '',
}: {
  kind: LaunchKind
  /** Sample buy/sell size used to label USDC on each leg. */
  notionalUsdc?: number
  showSideToggle?: boolean
  className?: string
}) {
  const [side, setSide] = useState<TradeSide>('buy')
  const fee = quoteFeeFromNotional(notionalUsdc)
  const legs = useMemo(() => splitUsdcFee(fee, kind), [fee, kind])
  const legacy = usesLegacyOnChainSplits()
  const kindLabel = kind === 'reflect' ? 'Reflect' : 'Meme'
  const col = legs.length <= 5 ? 'sm:grid-cols-5' : 'sm:grid-cols-3 lg:grid-cols-6'

  return (
    <div className={`border border-hair rounded-[24px] bg-s1 p-5 sm:p-[22px] ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
            Fee path · {kindLabel}
          </p>
          <h2 className="m-0 mt-1 text-[17px] font-semibold tracking-tightish">
            {side === 'buy' ? '1% USDC fee, quote side' : 'Sell · launch-token fee'}
          </h2>
          <p className="m-0 mt-1 text-[13px] text-t3">
            {side === 'buy'
              ? `On a ${fmtUsd(notionalUsdc)} buy, ${fmtFeeUsd(fee)} USDC splits across the legs below.`
              : 'The 1% sell fee is collected in the launch token and burned. Nobody is paid — not even the creator.'}
          </p>
        </div>
        {showSideToggle ? (
          <div className="flex gap-1 p-1 bg-s2 border border-hair rounded-xl">
            {(['buy', 'sell'] as TradeSide[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className="px-3.5 py-1.5 rounded-[9px] text-xs font-semibold capitalize transition-colors"
                style={{
                  background: side === s ? 'var(--lime)' : 'transparent',
                  color: side === s ? '#fff' : 'rgba(255,255,255,0.52)',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {side === 'buy' ? (
        <>
          <div className="mt-4 flex h-2.5 rounded-full overflow-hidden bg-black/40">
            {legs.map((leg) => (
              <div
                key={leg.id}
                className={leg.swatch}
                style={{ width: `${leg.pct}%` }}
                title={`${leg.label} ${fmtBpsPct(leg.bps)} · ${fmtFeeUsd(leg.usdc)}`}
              />
            ))}
          </div>
          <div className={`mt-3 grid grid-cols-2 ${col} gap-px bg-hair2 border border-hair rounded-[20px] overflow-hidden`}>
            {legs.map((leg) => (
              <div key={leg.id} className="px-3.5 py-3.5 bg-s1 flex flex-col gap-1 min-w-0">
                <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 inline-flex items-center gap-1.5 truncate">
                  <span className={`inline-block w-1.5 h-1.5 rounded-sm shrink-0 ${leg.swatch}`} />
                  {leg.label}
                </span>
                <span className="text-xl font-semibold tabular-nums tracking-[-0.028em] leading-tight text-lime-t">
                  {fmtBpsPct(leg.bps)}
                </span>
                <span className="text-xs font-semibold tabular-nums text-t3">
                  {fmtFeeUsd(leg.usdc)} USDC
                </span>
              </div>
            ))}
          </div>
          <p className="m-0 mt-3 text-[12px] text-t3 leading-snug">
            Missing referrer falls into Crucible. $ARCFUN holders do not get pad-wide USDC — Crucible
            is their reward.
          </p>
        </>
      ) : (
        <>
          <div className="mt-4 flex h-2.5 rounded-full overflow-hidden bg-black/40">
            <div className="bg-coral w-full" title="100% launch-token burn" />
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-px bg-hair2 border border-hair rounded-[20px] overflow-hidden">
            {[
              { n: '01', label: 'Collect', value: '1% fee', sub: 'in the launch token' },
              { n: '02', label: 'Dead wallet', value: '0x…dead', sub: 'sent, not paid out' },
              { n: '03', label: 'Burned forever', value: '100%', sub: 'nobody is paid' },
            ].map((step) => (
              <div key={step.n} className="px-4 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0">
                <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
                  {step.n} · {step.label}
                </span>
                <span className="text-xl font-semibold tabular-nums tracking-[-0.028em] leading-tight text-coral">
                  {step.value}
                </span>
                <span className="text-xs font-semibold text-t3">{step.sub}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {legacy ? (
        <p className="m-0 mt-3 text-[12px] text-t3 leading-snug border-t border-hair2 pt-3">
          Next · {CRUCIBLE_CONTRACTS_NOTE}
        </p>
      ) : null}
    </div>
  )
}
