/**
 * Thin Crucible status chip — last melt + burned amount. Preview until events exist.
 */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { mockCrucibleStats, type CrucibleStats } from '@/lib/crucible'
import { ageLabel, fmtCompact } from '@/lib/ui-format'

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

  return (
    <Link
      href="/crucible"
      title="Crucible — buy $ARCFUN from quote fees and burn it"
      className={`inline-flex items-center gap-2 rounded-xl border border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line transition-colors ${
        compact ? 'h-9 px-3 text-[12px] font-semibold' : 'h-9 px-3.5 text-[13px] font-semibold'
      } ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot shrink-0" />
      <span className="whitespace-nowrap tracking-tightish">
        {stats
          ? compact
            ? `Crucible · ${age} · ${burned} burned`
            : `Crucible · last melt ${age} · ${burned} burned`
          : 'Crucible'}
      </span>
    </Link>
  )
}
