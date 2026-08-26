/**
 * Buy/Sell fee path. Buy split is a donut (not Tolly's stacked bar / pipes).
 * Sell is a 3-step dead path — nobody is paid.
 */
'use client'

import { useMemo, useState } from 'react'
import {
  CRUCIBLE_CONTRACTS_NOTE,
  fmtBpsPct,
  quoteFeeFromNotional,
  splitUsdcFee,
  usesLegacyOnChainSplits,
  type FeeSplitLeg,
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

function conicFromLegs(legs: FeeSplitLeg[]): string {
  let acc = 0
  const stops: string[] = []
  for (const leg of legs) {
    const start = acc
    acc += leg.pct
    stops.push(`${leg.color} ${start}% ${acc}%`)
  }
  return `conic-gradient(${stops.join(', ')})`
}

export function FeeDonut({
  legs,
  center = '1%',
  centerLabel = 'Fee',
}: {
  legs: FeeSplitLeg[]
  center?: string
  centerLabel?: string
}) {
  return (
    <div className="flex flex-col sm:flex-row items-center gap-5 sm:gap-8">
      <div
        className="relative w-[168px] h-[168px] sm:w-[184px] sm:h-[184px] rounded-full shrink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
        style={{ background: conicFromLegs(legs) }}
        role="img"
        aria-label={legs.map((l) => `${l.label} ${fmtBpsPct(l.bps)}`).join(', ')}
      >
        <div className="absolute inset-[26%] rounded-full bg-s1 border border-hair flex flex-col items-center justify-center">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-t3">
            {centerLabel}
          </span>
          <span className="text-[22px] font-semibold tabular-nums tracking-tight leading-none mt-0.5">
            {center}
          </span>
        </div>
      </div>
      <ul className="m-0 p-0 list-none w-full flex-1 grid grid-cols-1 gap-2 min-w-0">
        {legs.map((leg) => (
          <li key={leg.id} className="flex items-center justify-between gap-3 min-w-0">
            <span className="inline-flex items-center gap-2 min-w-0 text-[13px] font-semibold text-t2">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: leg.color }}
              />
              <span className="truncate">{leg.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-[13px] font-semibold">
              <span className="text-white">{fmtBpsPct(leg.bps)}</span>
              <span className="text-t3 font-medium"> · {fmtFeeUsd(leg.usdc)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
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
              ? `On a ${fmtUsd(notionalUsdc)} buy, ${fmtFeeUsd(fee)} USDC splits across the pie.`
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
          <div className="mt-5">
            <FeeDonut legs={legs} />
          </div>
          <p className="m-0 mt-4 text-[12px] text-t3 leading-snug">
            Missing referrer falls into Crucible. $ARCFUN holders do not get pad-wide USDC — Crucible
            is their reward.
          </p>
        </>
      ) : (
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-px bg-hair2 border border-hair rounded-[20px] overflow-hidden">
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
      )}

      {legacy ? (
        <p className="m-0 mt-3 text-[12px] text-t3 leading-snug border-t border-hair2 pt-3">
          Next · {CRUCIBLE_CONTRACTS_NOTE}
        </p>
      ) : null}
    </div>
  )
}
