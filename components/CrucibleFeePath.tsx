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

function sliceColor(leg: FeeSplitLeg, hoverId: string | null): string {
  if (!hoverId) return leg.color
  if (hoverId === leg.id) return leg.color
  return `color-mix(in srgb, ${leg.color} 38%, #0b0f16)`
}

function conicFromLegs(legs: FeeSplitLeg[], hoverId: string | null): string {
  let acc = 0
  const stops: string[] = []
  for (const leg of legs) {
    const start = acc
    acc += leg.pct
    stops.push(`${sliceColor(leg, hoverId)} ${start}% ${acc}%`)
  }
  if (acc < 99.5) stops.push(`#0b0f16 ${acc}% 100%`)
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
  const [hoverId, setHoverId] = useState<string | null>(null)
  const pieKey = legs.map((l) => `${l.id}:${l.bps}`).join('|')
  const hovering = hoverId != null

  return (
    <div className="flex flex-col items-center sm:flex-row sm:items-center gap-5 sm:gap-8 min-w-0 w-full">
      <div
        key={pieKey}
        className="relative w-[220px] h-[220px] sm:w-[184px] sm:h-[184px] rounded-full shrink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] crucible-in"
        style={{ background: conicFromLegs(legs, hoverId) }}
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
      <ul className="m-0 p-0 list-none w-full flex-1 grid grid-cols-1 gap-1 min-w-0">
        {legs.map((leg) => {
          const active = hoverId === leg.id
          const dim = hovering && !active
          return (
            <li
              key={leg.id}
              className="flex items-center justify-between gap-3 min-w-0 rounded-xl px-3 py-2.5 sm:py-1.5 -mx-1 transition-[background,opacity,filter] duration-200"
              style={{
                background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                opacity: dim ? 0.45 : 1,
                filter: active ? 'brightness(1.12)' : undefined,
              }}
              onMouseEnter={() => setHoverId(leg.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => setHoverId((cur) => (cur === leg.id ? null : leg.id))}
            >
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
          )
        })}
      </ul>
    </div>
  )
}

function withReferrerSlice(legs: FeeSplitLeg[]): FeeSplitLeg[] {
  if (legs.some((l) => l.id === 'referrer')) return legs
  const crucible = legs.find((l) => l.id === 'crucible')
  const feeUsdc = legs.reduce((n, l) => n + l.usdc, 0)
  const refUsdc = feeUsdc * 0.05
  const ref: FeeSplitLeg = {
    id: 'referrer',
    label: 'Referrer',
    bps: 500,
    swatch: 'bg-amber-500',
    color: '#f5b942',
    usdc: refUsdc,
    pct: 5,
  }
  if (!crucible) return [...legs, ref]
  return [
    ...legs.map((l) =>
      l.id === 'crucible'
        ? { ...l, bps: l.bps - 500, usdc: l.usdc - refUsdc, pct: l.pct - 5 }
        : l,
    ),
    ref,
  ]
}

function BuyPanel({ kind, legs }: {
  kind: LaunchKind
  legs: FeeSplitLeg[]
}) {
  const shown = withReferrerSlice(legs)
  return (
    <>
      <FeeDonut key={kind} legs={shown} />
      <p className="m-0 mt-4 text-[12px] text-t3 leading-snug">
        Refer and earn 5% of trading fees from buys through your link.
      </p>
    </>
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

  const buyBody = (
    <BuyPanel kind={kind} legs={legs} />
  )

  const sellBody = (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-hair2 border border-hair rounded-[20px] overflow-hidden">
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
  )

  return (
    <div className={`relative border border-hair rounded-[24px] bg-s1 p-5 sm:p-[22px] ${className}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
            Fee path · {kindLabel}
          </p>
          {showSideToggle ? (
            <div className="grid mt-1">
              <div
                className={`col-start-1 row-start-1 crucible-xfade ${
                  side === 'buy' ? 'opacity-100 z-[1]' : 'opacity-0 pointer-events-none'
                }`}
                aria-hidden={side !== 'buy'}
              >
                <h2 className="m-0 text-[17px] font-semibold tracking-tightish">
                  1% USDC fee, quote side
                </h2>
                <p className="m-0 mt-1 text-[13px] text-t3">
                  On a {fmtUsd(notionalUsdc)} buy, {fmtFeeUsd(fee)} USDC splits across the pie.
                </p>
              </div>
              <div
                className={`col-start-1 row-start-1 crucible-xfade ${
                  side === 'sell' ? 'opacity-100 z-[1]' : 'opacity-0 pointer-events-none'
                }`}
                aria-hidden={side !== 'sell'}
              >
                <h2 className="m-0 text-[17px] font-semibold tracking-tightish">
                  Sell · launch-token fee
                </h2>
                <p className="m-0 mt-1 text-[13px] text-t3">
                  The 1% sell fee is collected in the launch token and burned. Nobody is paid — not
                  even the creator.
                </p>
              </div>
            </div>
          ) : (
            <>
              <h2 className="m-0 mt-1 text-[17px] font-semibold tracking-tightish">
                1% USDC fee, quote side
              </h2>
              <p className="m-0 mt-1 text-[13px] text-t3">
                On a {fmtUsd(notionalUsdc)} buy, {fmtFeeUsd(fee)} USDC splits across the pie.
              </p>
            </>
          )}
        </div>
        {showSideToggle ? (
          <div className="flex gap-1 p-1 bg-s2 border border-hair rounded-xl shrink-0 self-start">
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

      {showSideToggle ? (
        <div className="mt-5 grid">
          <div
            className={`col-start-1 row-start-1 min-w-0 crucible-xfade ${
              side === 'buy' ? 'opacity-100 z-[1]' : 'opacity-0 pointer-events-none'
            }`}
            aria-hidden={side !== 'buy'}
          >
            {buyBody}
          </div>
          <div
            className={`col-start-1 row-start-1 min-w-0 crucible-xfade ${
              side === 'sell' ? 'opacity-100 z-[1]' : 'opacity-0 pointer-events-none'
            }`}
            aria-hidden={side !== 'sell'}
          >
            {sellBody}
          </div>
        </div>
      ) : (
        <div className="mt-5 min-w-0">{buyBody}</div>
      )}

      {legacy ? (
        <p className="m-0 mt-3 text-[12px] text-t3 leading-snug border-t border-hair2 pt-3">
          Next · {CRUCIBLE_CONTRACTS_NOTE}
        </p>
      ) : null}
    </div>
  )
}
