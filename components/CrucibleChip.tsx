/**
 * Thin Crucible status chip — last burn + burned amount. Preview until events exist.
 */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { mockCrucibleStats, type CrucibleStats } from '@/lib/crucible'
import { ageLabel, fmtCompact, fmtUsd } from '@/lib/ui-format'

function fmtBurnedPct(p: number): string {
  if (!Number.isFinite(p)) return '—'
  if (p <= 0) return '0%'
  if (p < 0.1) return '<0.1%'
  if (p >= 99.95) return '100%'
  if (p < 1) return `${p.toFixed(2)}%`
  return `${p.toFixed(1)}%`
}

/** Tiny client island: count-up on first paint, tabular-nums, reduced-motion aware. */
export function CrucibleCountUp({
  value,
  kind,
}: {
  value: number
  kind: 'usd' | 'compact' | 'pct'
}) {
  const [n, setN] = useState(0)

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !Number.isFinite(value) || value === 0) {
      setN(value)
      return
    }
    const t0 = performance.now()
    const dur = 700
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const eased = 1 - (1 - p) ** 3
      setN(value * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  const text =
    kind === 'usd' ? fmtUsd(n) : kind === 'compact' ? fmtCompact(n) : fmtBurnedPct(n)

  return <span className="tabular-nums">{text}</span>
}

export function CrucibleChip({
  compact = false,
  className = '',
}: {
  compact?: boolean
  className?: string
}) {
  const [stats, setStats] = useState<CrucibleStats | null>(null)

  useEffect(() => {
    setStats(mockCrucibleStats())
  }, [])

  const last = stats?.lastMelt
  const age = last ? ageLabel(last.ts) : '—'
  const burned = stats ? fmtCompact(stats.arcfunAtDead) : '—'
  const full = `Burn tape · ${age} · ${burned} burned`

  return (
    <Link
      href="/crucible"
      title={stats ? full : 'Crucible — buy $ARCFUN from quote fees and burn it'}
      className={`inline-flex items-center gap-2 rounded-xl border border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line transition-colors ${
        compact ? 'h-9 px-3 text-[12px] font-semibold' : 'h-9 px-3.5 text-[13px] font-semibold'
      } ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot shrink-0" />
      <span className="whitespace-nowrap tracking-tightish tabular-nums">
        {compact ? 'Crucible' : stats ? full : 'Crucible'}
      </span>
    </Link>
  )
}
