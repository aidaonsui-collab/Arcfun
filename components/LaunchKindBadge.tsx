import type { PoolToken } from '@/lib/tokens'
import { isReflectionToken } from '@/lib/tokens'

/**
 * Small product badge: Reflection (holder rewards) vs Uni V3 Instant vs Curve.
 */
export function LaunchKindBadge({
  token,
  size = 'sm',
  className = '',
}: {
  token: Pick<PoolToken, 'reflection' | 'launchKind' | 'moonbagsPackageId' | 'instant' | 'instantLaunch'>
  size?: 'sm' | 'md'
  className?: string
}) {
  const pad = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-1 text-[11px]'
  const base = `shrink-0 inline-flex items-center gap-1 rounded-[9px] font-semibold backdrop-blur-[10px] ${pad} ${className}`

  if (isReflectionToken(token)) {
    return (
      <span
        className={`${base} bg-violet-500/25 border border-violet-400/40 text-violet-200`}
        title="Instant Reflection — holders earn USDC rewards from trading fees"
      >
        ◈ Reflect
      </span>
    )
  }

  if (token.launchKind === 'curve') {
    return (
      <span
        className={`${base} bg-amber-500/20 border border-amber-400/35 text-amber-200`}
        title="Bonding curve launch"
      >
        Curve
      </span>
    )
  }

  // Instant / Uni V3 is the default product — no badge on tiles.
  return null
}
