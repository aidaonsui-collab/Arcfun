import Link from 'next/link'
import type { PoolToken } from '@/lib/tokens'
import {
  ageLabel,
  changeParts,
  fmtUsd,
  sparkPath,
  tileGradient,
} from '@/lib/ui-format'

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
  const spark = sparkPath(seed, 26, token.priceChange24h ?? 0)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const rankLabel =
    rank != null ? (rank + 1 < 10 ? `0${rank + 1}` : String(rank + 1)) : null
  const age = ageLabel(token.createdAt ?? token.lastTradeAt)
  const creator = token.creatorShort || (token.creator ? `${token.creator.slice(0, 6)}…` : '')

  return (
    <Link
      href={`/token/${address}`}
      className="group text-left border border-hair rounded-[24px] overflow-hidden bg-s1 flex flex-col transition-colors hover:border-lime-line"
    >
      <span
        className="relative block aspect-[16/10] flex items-center justify-center"
        style={{ background: img ? undefined : tile }}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span
            className="text-[64px] font-bold tracking-[-0.05em] leading-none"
            style={{ color: mono }}
          >
            {initial}
          </span>
        )}
        <span className="absolute top-3 left-3 flex gap-1.5">
          <span className="px-2 py-1 rounded-[9px] bg-black/50 backdrop-blur-[10px] text-[11px] font-semibold text-white">
            {age}
          </span>
          {creator ? (
            <span className="px-2 py-1 rounded-[9px] bg-black/50 backdrop-blur-[10px] text-[11px] font-medium text-white/80">
              {creator.startsWith('@') || creator.startsWith('0x') ? creator : creator}
            </span>
          ) : null}
        </span>
        {(token.instant || token.instantLaunch) && (
          <span className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 rounded-[9px] bg-black/50 backdrop-blur-[10px] text-[11px] font-semibold text-lime-t">
            ⚡ Instant
          </span>
        )}
      </span>

      <span className="px-[18px] pt-4 pb-[18px] flex flex-col gap-2.5">
        <span className="flex items-baseline gap-2 min-w-0">
          {rankLabel && (
            <span className="text-xs font-bold text-lime-t tabular-nums shrink-0">{rankLabel}</span>
          )}
          <span className="text-base font-semibold tracking-tightish truncate flex-1">
            {token.name || 'Unnamed'}
          </span>
          <span className="text-xs font-semibold text-t3 shrink-0">${token.symbol}</span>
        </span>

        <span className="flex items-end gap-3">
          <span className="flex flex-col gap-0.5 shrink-0">
            <span className="text-[21px] font-semibold tabular-nums tracking-[-0.028em] leading-none">
              {fmtUsd(token.marketCap)}
            </span>
            <span className="text-[11px] text-t3 tabular-nums">
              Vol {fmtUsd(token.volume1h)}
            </span>
          </span>
          <svg
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            className="flex-1 min-w-0 h-[30px] opacity-90"
          >
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
          <span
            className="shrink-0 px-2 py-1 rounded-[9px] text-xs font-bold tabular-nums whitespace-nowrap"
            style={{ background: chg.chipBg, color: chg.chipFg }}
          >
            {chg.label}
          </span>
        </span>
      </span>
    </Link>
  )
}

/** Compact horizontal rail card for "Just launched". */
export function TokenRailCard({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const chg = changeParts(token.priceChange24h)
  const spark = sparkPath(seed, 26, token.priceChange24h ?? 0)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt ?? token.lastTradeAt)

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
          <img src={img} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="text-[34px] font-bold tracking-[-0.04em]" style={{ color: mono }}>
            {initial}
          </span>
        )}
        <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-lg bg-black/55 backdrop-blur-sm text-[10px] font-semibold text-white">
          {age}
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
      </span>
    </Link>
  )
}
