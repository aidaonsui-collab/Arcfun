import Link from 'next/link'
import type { PoolToken } from '@/lib/tokens'
import { LaunchKindBadge } from '@/components/LaunchKindBadge'
import { ageLabel, changeParts, fmtUsd, sparkPathFromValues, tileGradient } from '@/lib/ui-format'
import { cdnImage } from '@/lib/cdn-image'

export function TokenCard({
  token,
  rank,
}: {
  token: PoolToken
  rank?: number
}) {
  const address = token.coinType || token.poolId
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const chg = changeParts(token.priceChange24h)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const rankLabel =
    rank != null ? (rank + 1 < 10 ? `0${rank + 1}` : String(rank + 1)) : null
  const age = ageLabel(token.createdAt)

  return (
    <div className="group relative text-left border border-hair rounded-[20px] overflow-hidden bg-s1 flex flex-col transition-[transform,border-color] duration-200 ease-out hover:border-lime-line hover:scale-[1.03] hover:z-[3]">
      <Link href={`/token/${address}`} className="absolute inset-0 z-0" aria-label={token.name || 'Token'} />
      <span
        key={address || seed}
        className="relative block aspect-square flex items-center justify-center pointer-events-none tile-media-in"
        style={{ background: img ? undefined : tile }}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cdnImage(img, 320)} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span
            className="text-[64px] font-bold tracking-[-0.05em] leading-none"
            style={{ color: mono }}
          >
            {initial}
          </span>
        )}
        <span className="absolute top-2.5 left-2.5 right-2.5 flex items-start justify-between gap-1.5 pointer-events-auto z-10">
          <span className="shrink-0 px-2 py-1 rounded-[9px] bg-black/50 backdrop-blur-[10px] text-[11px] font-semibold text-white">
            {age}
          </span>
          <LaunchKindBadge token={token} />
        </span>
      </span>

      {/* Pools.trade-style bottom block: name, then price + change on one line — no ticker,
          no volume line, no sparkline (kept only in the "Top Memes" rail card). */}
      <span className="px-3.5 pt-3 pb-3.5 flex flex-col gap-1 relative z-[1] pointer-events-none">
        <span className="flex items-baseline gap-1.5 min-w-0">
          {rankLabel && (
            <span className="text-xs font-bold text-lime-t tabular-nums shrink-0">{rankLabel}</span>
          )}
          <span className="text-sm font-semibold tracking-tightish truncate">
            {token.name || 'Unnamed'}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2 relative z-[1] pointer-events-none">
          <span className="text-lg font-bold tabular-nums tracking-[-0.02em]">
            {fmtUsd(token.marketCap)}
          </span>
          <span
            className="shrink-0 text-[13px] font-bold tabular-nums whitespace-nowrap"
            style={{ color: chg.stroke }}
          >
            {chg.label}
          </span>
        </span>
      </span>
    </div>
  )
}

/** Compact horizontal rail card for "Top Memes". */
export function TokenRailCard({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const chg = changeParts(token.priceChange24h)
  const spark = sparkPathFromValues(token.sparkCloses ?? [])
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt)

  return (
    <Link
      href={`/token/${address}`}
      className="flex-none w-[300px] flex items-stretch border border-hair rounded-[20px] overflow-hidden bg-s1 hover:border-lime-line transition-colors"
    >
      <span
        className="relative w-24 shrink-0 flex items-center justify-center"
        style={{ background: img ? undefined : tile }}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cdnImage(img, 96)} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="text-[34px] font-bold tracking-[-0.04em]" style={{ color: mono }}>
            {initial}
          </span>
        )}
        <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-lg bg-black/55 backdrop-blur-sm text-[10px] font-semibold text-white">
          {age}
        </span>
        <span className="absolute bottom-2 left-2 scale-90 origin-bottom-left">
          <LaunchKindBadge token={token} />
        </span>
      </span>
      <span className="flex-1 min-w-0 px-4 py-3.5 flex flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold tracking-tightish truncate">
            {token.name || 'Unnamed'}
          </span>
          <span
            className="shrink-0 px-2 py-0.5 rounded-lg text-[11px] font-bold tabular-nums"
            style={{ background: chg.chipBg, color: chg.chipFg }}
          >
            {chg.label}
          </span>
        </span>
        <span className="text-[19px] font-semibold tabular-nums tracking-[-0.028em]">
          {fmtUsd(token.marketCap)}
        </span>
        {spark ? (
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-full h-[22px] opacity-85">
            <path
              d={spark}
              fill="none"
              stroke={chg.stroke}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <span className="block h-[22px]" />
        )}
      </span>
    </Link>
  )
}
