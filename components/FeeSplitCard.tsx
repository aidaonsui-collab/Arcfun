'use client'

/**
 * Launch-fee chooser. Buy and sell fees, then the same destination split.
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  FEE_LEGS,
  FEE_PRESET_META,
  FEE_SPLIT_PRESETS,
  MAX_FEE_BPS,
  MIN_FEE_BPS,
  MIN_PLATFORM_BPS,
  bpsKey,
  clampFeeBps,
  conicStops,
  feePairLabel,
  feePctLabel,
  matchPreset,
  pctLabel,
  splitRemaining,
  splitValid,
  type FeeSplit,
  type FeeSplitId,
  type FeeLeg,
} from '@/lib/eve-fee-split'

const PRESET_ORDER: FeeSplitId[] = ['creator', 'reflect', 'scorched', 'pool', 'custom']

export function FeeSplitCard({
  split,
  onChange,
  hideHolders = false,
  minHoldersBps = 0,
  requireEqualFees = false,
  maxFeeBps = MAX_FEE_BPS,
  preview = false,
  open,
  onOpenChange,
}: {
  split: FeeSplit
  onChange: (next: FeeSplit) => void
  hideHolders?: boolean
  minHoldersBps?: number
  /** Live single-fee factories cannot store a different sell fee. */
  requireEqualFees?: boolean
  /** Single-fee factories cap at 3%. Dual-fee factories cap at 5%. */
  maxFeeBps?: number
  preview?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const check = splitValid(split, { hideHolders, minHoldersBps, requireEqualFees, maxFeeBps })
  const remaining = splitRemaining(split)
  const preset = matchPreset(split)
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [linked, setLinked] = useState(split.buyFeeBps === split.sellFeeBps)
  const pairLabel = feePairLabel(split.buyFeeBps, split.sellFeeBps)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const applyPreset = (id: FeeSplitId) => {
    if (id === 'custom') return
    if (hideHolders && id === 'reflect') return
    if (minHoldersBps > 0 && id !== 'reflect' && FEE_SPLIT_PRESETS[id].holdersBps < minHoldersBps) return
    setLinked(true)
    onChange(FEE_SPLIT_PRESETS[id])
  }

  const setBuyFee = (bps: number) => {
    const clamped = clampFeeBps(bps, maxFeeBps)
    onChange({
      ...split,
      buyFeeBps: clamped,
      sellFeeBps: linked ? clamped : split.sellFeeBps,
    })
  }

  const setSellFee = (bps: number) => {
    const clamped = clampFeeBps(bps, maxFeeBps)
    onChange({ ...split, sellFeeBps: clamped })
  }

  const setLeg = (leg: FeeLeg, bps: number) => {
    const key = bpsKey(leg)
    const min = leg === 'platform' ? MIN_PLATFORM_BPS : 0
    const next = Math.min(10_000, Math.max(min, Math.round(bps / 100) * 100))
    onChange({ ...split, [key]: next })
  }

  const visibleLegs = hideHolders ? FEE_LEGS.filter((l) => l.key !== 'holders') : FEE_LEGS

  const summary = (
    <button
      type="button"
      onClick={() => onOpenChange(true)}
      className="group w-full rounded-2xl bg-s1 border border-hair hover:border-lime-line text-left p-4 transition-colors"
    >
      <div className="flex items-center gap-4">
        <Donut split={split} hideHolders={hideHolders} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Launch fee</span>
            <span className="text-[11px] font-semibold tabular-nums text-lime-t">
              {pairLabel} · {FEE_PRESET_META[preset].title}
            </span>
          </div>
          <p className="mt-1 mb-0 text-xs text-t2 leading-snug">
            {split.buyFeeBps === split.sellFeeBps
              ? 'Same cut on buys and sells. Tap to pick where it goes.'
              : 'Buy and sell fees differ. Tap to edit the split.'}
          </p>
          {!check.ok && check.reason ? (
            <p className="mt-2 mb-0 text-[11px] leading-snug text-coral">{check.reason}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-[12px] font-semibold text-lime-t group-hover:text-white">
          Adjust
        </span>
      </div>
      {preview ? (
        <p className="mt-3 mb-0 text-[11px] leading-snug text-t3">
          Preview — this launch still uses the live Instant pool until the v4 factory is on.
        </p>
      ) : null}
    </button>
  )

  if (!open) return summary

  return (
    <>
      {summary}
      <div
        className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-6"
        role="presentation"
      >
        <button
          type="button"
          aria-label="Close fee editor"
          className="absolute inset-0 bg-[#04070c]/78"
          onClick={() => onOpenChange(false)}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="relative z-[1] w-full sm:max-w-[34rem] max-h-[92dvh] overflow-hidden rounded-t-[28px] sm:rounded-[28px] outline-none flex flex-col"
          style={{
            background: 'linear-gradient(180deg, #121a28 0%, #0c121c 48%, #0a0f18 100%)',
            boxShadow: '0 0 0 1px rgba(124,255,58,0.22), 0 28px 80px rgba(0,0,0,0.55)',
          }}
        >
          <div className="h-1.5 w-full shrink-0 bg-[linear-gradient(90deg,#7cff3a_0%,#2f84db_55%,#7ec0f7_100%)]" />
          <div className="px-5 pt-5 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-6 overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="m-0 text-[11px] font-semibold tracking-[0.18em] uppercase text-fun">
                  Pool fee
                </p>
                <h2 id={titleId} className="mt-1 mb-0 text-[22px] font-semibold tracking-tight">
                  Where the cut goes
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-9 px-3 rounded-xl text-[13px] font-semibold text-t2 hover:text-white border border-hair bg-white/[0.03]"
              >
                Done
              </button>
            </div>

            <div className="mt-5 flex items-center gap-5">
              <Donut split={split} hideHolders={hideHolders} size={92} />
              <div className="min-w-0 flex-1">
                <div className="text-[28px] font-semibold tabular-nums tracking-tight leading-none">
                  {split.buyFeeBps === split.sellFeeBps ? feePctLabel(split.buyFeeBps) : pairLabel}
                </div>
                <p className="mt-2 mb-0 text-[12px] text-t2 leading-snug">
                  Fee is taken from what the trader receives. Split below decides where it goes.
                </p>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <span className="text-[12px] text-t3">Buy and sell</span>
              <button
                type="button"
                onClick={() => {
                  if (linked) {
                    setLinked(false)
                    return
                  }
                  setLinked(true)
                  onChange({ ...split, sellFeeBps: split.buyFeeBps })
                }}
                className={`h-8 px-3 rounded-full text-[12px] font-semibold border ${
                  linked
                    ? 'bg-lime text-white border-transparent'
                    : 'border-hair text-t2 bg-white/[0.03]'
                }`}
              >
                {linked ? 'Same on buys and sells' : 'Set separately'}
              </button>
            </div>

            <FeeSlider
              label="Buy fee"
              value={split.buyFeeBps}
              maxBps={maxFeeBps}
              onChange={setBuyFee}
            />
            <FeeSlider
              label="Sell fee"
              value={split.sellFeeBps}
              maxBps={maxFeeBps}
              onChange={linked ? setBuyFee : setSellFee}
              disabled={linked}
            />

            <div className="mt-5 flex flex-wrap gap-1.5">
              {PRESET_ORDER.map((id) => {
                const blocked =
                  (hideHolders && id === 'reflect') ||
                  (minHoldersBps > 0 &&
                    id !== 'custom' &&
                    id !== 'reflect' &&
                    FEE_SPLIT_PRESETS[id].holdersBps < minHoldersBps)
                const on = preset === id
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={blocked}
                    onClick={() => applyPreset(id)}
                    className={`h-8 px-3 rounded-full text-[12px] font-semibold transition-colors ${
                      blocked
                        ? 'opacity-35 cursor-not-allowed text-t3 border border-transparent'
                        : on
                          ? 'bg-lime text-white'
                          : 'border border-hair text-t2 hover:text-white hover:border-lime-line bg-white/[0.03]'
                    }`}
                  >
                    {FEE_PRESET_META[id].title}
                  </button>
                )
              })}
            </div>

            <div className="mt-5 space-y-3.5">
              {visibleLegs.map((leg) => {
                const bps = split[bpsKey(leg.key)]
                const min = leg.key === 'platform' ? MIN_PLATFORM_BPS : 0
                return (
                  <div key={leg.key}>
                    <div className="flex items-baseline justify-between gap-3 mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="size-2 rounded-full shrink-0"
                          style={{ background: leg.color }}
                        />
                        <span className="text-[13px] font-medium">{leg.label}</span>
                        <span className="text-[11px] text-t3 truncate">{leg.hint}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={min / 100}
                          max={100}
                          step={1}
                          value={Math.round(bps / 100)}
                          onChange={(e) => setLeg(leg.key, Number(e.target.value) * 100)}
                          className="w-14 h-7 rounded-lg bg-s2 border border-hair text-right text-[13px] font-semibold tabular-nums px-2 outline-none focus:border-lime-line"
                          aria-label={`${leg.label} percent`}
                        />
                        <span className="text-[12px] text-t3">%</span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={10_000}
                      step={100}
                      value={bps}
                      onChange={(e) => setLeg(leg.key, Number(e.target.value))}
                      className="fee-range w-full"
                      style={{ accentColor: leg.color }}
                      aria-label={`${leg.label} allocation`}
                    />
                  </div>
                )
              })}
            </div>

            <div
              className={`mt-5 rounded-2xl px-3.5 py-2.5 text-[12px] leading-snug ${
                check.ok
                  ? 'bg-fun/10 text-fun border border-fun/25'
                  : 'bg-coral/10 text-coral border border-coral/25'
              }`}
            >
              {check.ok
                ? split.buyFeeBps === split.sellFeeBps
                  ? '100% allocated.'
                  : `100% allocated. ${pairLabel}.`
                : check.reason || `Allocate ${pctLabel(Math.abs(remaining))}.`}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function FeeSlider({
  label,
  value,
  maxBps,
  onChange,
  disabled = false,
}: {
  label: string
  value: number
  maxBps: number
  onChange: (bps: number) => void
  disabled?: boolean
}) {
  return (
    <div className={`mt-4 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] text-t3">{label}</span>
        <span className="text-[13px] font-semibold tabular-nums text-white">{feePctLabel(value)}</span>
      </div>
      <input
        type="range"
        min={MIN_FEE_BPS}
        max={maxBps}
        step={10}
        value={Math.min(value, maxBps)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="fee-range w-full"
        aria-label={label}
      />
      <div className="mt-1 flex justify-between text-[11px] text-t3 tabular-nums">
        <span>0.3%</span>
        <span>{feePctLabel(maxBps)}</span>
      </div>
    </div>
  )
}

function Donut({
  split,
  hideHolders,
  size,
}: {
  split: FeeSplit
  hideHolders: boolean
  size: number
}) {
  const hole = Math.round(size * 0.58)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${conicStops(split, hideHolders)})` }}
      />
      <div
        className="absolute rounded-full bg-s1"
        style={{
          width: hole,
          height: hole,
          left: (size - hole) / 2,
          top: (size - hole) / 2,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
        }}
      />
    </div>
  )
}
