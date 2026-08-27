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

function hitLegId(
  e: { currentTarget: HTMLElement; clientX: number; clientY: number },
  legs: FeeSplitLeg[],
): string | null {
  const rect = e.currentTarget.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dx = e.clientX - cx
  const dy = e.clientY - cy
  const r = Math.hypot(dx, dy)
  const outer = rect.width / 2
  const inner = outer * 0.48
  if (r < inner || r > outer) return null
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
  if (deg < 0) deg += 360
  const pct = (deg / 360) * 100
  let acc = 0
  for (const leg of legs) {
    acc += leg.pct
    if (pct <= acc + 1e-6) return leg.id
  }
  return legs[legs.length - 1]?.id ?? null
}

function feeLegBlurb(leg: FeeSplitLeg): string {
  switch (leg.id) {
    case 'creator':
      return 'Paid in USDC to the rewards wallet set at launch. Defaults to the wallet that signed the create.'
    case 'crucible':
      return 'Quote USDC sits here. When it cooks, Crucible buys $ARCFUN and burns it. A buy/burn no one has to click.'
    case 'projectBurn':
      return 'This USDC buys the launch token and sends it to the dead wallet.'
    case 'platform':
      return "Arcfun's cut. Keeps the pad running."
    case 'referrer':
      return 'Instant payout on Arcfun buys through your link. Extra to the 1% pool fee. Direct Uni swaps skip this.'
    case 'holders':
      return 'USDC for people holding this token. Claim from Profile after the keeper calls reflect().'
    default:
      return `${fmtBpsPct(leg.bps)} of the quote-side 1% USDC fee.`
  }
}

export function FeeDonut({
  legs,
  center = '1%',
  centerLabel = 'Fee',
  hoverId = null,
  onHoverId,
  onPinId,
}: {
  legs: FeeSplitLeg[]
  center?: string
  centerLabel?: string
  hoverId?: string | null
  onHoverId?: (id: string | null) => void
  onPinId?: (id: string) => void
}) {
  const pieKey = legs.map((l) => `${l.id}:${l.bps}`).join('|')
  const hovering = hoverId != null
  const setHover = (id: string | null) => onHoverId?.(id)
  const pin = (id: string) => onPinId?.(id)

  return (
    <div className="flex flex-col items-center sm:flex-row sm:items-center gap-5 sm:gap-8 min-w-0 w-full">
      <div
        key={pieKey}
        className="relative w-[220px] h-[220px] sm:w-[184px] sm:h-[184px] rounded-full shrink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] crucible-in cursor-pointer"
        style={{ background: conicFromLegs(legs, hoverId) }}
        role="img"
        aria-label={legs.map((l) => `${l.label} ${fmtBpsPct(l.bps)}`).join(', ')}
        onMouseMove={(e) => {
          const id = hitLegId(e, legs)
          if (id) setHover(id)
        }}
        onClick={(e) => {
          const id = hitLegId(e, legs)
          if (id) pin(id)
        }}
      >
        <div className="absolute inset-[26%] rounded-full bg-s1 border border-hair flex flex-col items-center justify-center pointer-events-none">
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
              className="flex items-center justify-between gap-3 min-w-0 rounded-xl px-3 py-2.5 sm:py-1.5 -mx-1 cursor-pointer transition-[background,opacity,filter] duration-200"
              style={{
                background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                opacity: dim ? 0.45 : 1,
                filter: active ? 'brightness(1.12)' : undefined,
              }}
              onMouseEnter={() => setHover(leg.id)}
              onClick={() => pin(leg.id)}
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

const IDLE_FEE_NOTE = 'Refer and earn 5% of trading fees from buys through your link.'

function BuyPanel({ kind, legs }: {
  kind: LaunchKind
  legs: FeeSplitLeg[]
}) {
  const shown = withReferrerSlice(legs)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const activeId = hoverId ?? pinnedId
  const active = shown.find((l) => l.id === activeId) ?? null

  return (
    <div
      onMouseLeave={() => setHoverId(null)}
    >
      <FeeDonut
        key={kind}
        legs={shown}
        hoverId={activeId}
        onHoverId={setHoverId}
        onPinId={(id) => setPinnedId((cur) => (cur === id ? null : id))}
      />
      <p
        className="m-0 mt-4 min-h-[2.6em] text-[12px] text-t3 leading-snug"
        aria-live="polite"
      >
        {active ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-semibold text-t2">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ background: active.color }}
              />
              {active.label}
            </span>
            {' · '}
            {feeLegBlurb(active)}
          </>
        ) : (
          IDLE_FEE_NOTE
        )}
      </p>
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

  const buyBody = (
    <BuyPanel key={kind} kind={kind} legs={legs} />
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
            <span className="normal-case tracking-normal font-semibold text-t3"> (coming soon)</span>
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
