import Link from 'next/link'
import type { PoolToken } from '@/lib/tokens'
import { isReflectionToken } from '@/lib/tokens'
import { LaunchKindBadge } from '@/components/LaunchKindBadge'
import { ageLabel, changeParts, fmtUsd, sparkPathFromValues, tileGradient } from '@/lib/ui-format'
import { cdnImage } from '@/lib/cdn-image'

function QuoteMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-lime-t" aria-hidden>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <circle cx="8" cy="8" r="5.2" fill="var(--bg)" />
      <text
        x="8"
        y="11"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fill="currentColor"
      >
        $
      </text>
    </svg>
  )
}

export function TokenCard({
  token,
  preview = false,
}: {
  token: PoolToken
  rank?: number
  preview?: boolean
}) {
  const address = token.coinType || token.poolId
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const chg = changeParts(token.priceChange24h)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt)
  const quote = token.instantMeta?.quote || 'USDC'
  const pct = token.priceChange24h ?? 0
  const pctLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  const frame =
    'group relative block overflow-hidden rounded-[20px] bg-s1 p-5 border border-hair transition-[border-color,transform] duration-200 ease-out hover:border-lime-line hover:z-[3]'

  const body = (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute -right-8 top-1/2 size-56 -translate-y-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(circle at 48% 50%, rgba(47, 132, 219, 0.32) 0%, rgba(47, 132, 219, 0.12) 38%, transparent 70%)',
        }}
      />
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${address}-wm`}
          src={cdnImage(img, 320)}
          alt=""
          className="pointer-events-none absolute -right-6 top-1/2 size-44 -translate-y-1/2 rounded-full object-cover opacity-[0.48] mix-blend-lighten tile-media-in"
          style={{ filter: 'drop-shadow(0 0 26px rgba(47, 132, 219, 0.32))' }}
        />
      ) : (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-4 top-1/2 -translate-y-1/2 text-[7rem] font-bold leading-none opacity-[0.16]"
          style={{ color: mono, filter: 'drop-shadow(0 0 18px rgba(47, 132, 219, 0.22))' }}
        >
          {initial}
        </span>
      )}
      <span className="relative flex items-start justify-between">
        <span
          className="size-11 rounded-full overflow-hidden shrink-0 flex items-center justify-center border border-hair"
          style={{ background: img ? undefined : tile }}
        >
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${address}-av`}
              src={cdnImage(img, 96)}
              alt=""
              className="size-full object-cover tile-media-in"
            />
          ) : (
            <span className="text-sm font-bold" style={{ color: mono }}>
              {initial}
            </span>
          )}
        </span>
      </span>
      <span className="relative mt-8 block">
        <span className="block text-xs font-medium tracking-wide text-t3 uppercase">
          ${token.symbol || 'TOKEN'}
        </span>
        <span className="mt-1 block text-[1.85rem] leading-none font-semibold tracking-tight tabular-nums">
          {fmtUsd(token.marketCap)}
        </span>
        <span className="mt-3 flex flex-wrap items-center gap-2 text-xs text-t2">
          <span className="inline-flex items-center gap-1.5">
            Paired with
            <QuoteMark />
            <span className="text-white/80">{quote}</span>
          </span>
          <span className="text-t3">·</span>
          <span>{age}</span>
          {isReflectionToken(token) ? (
            <span className="px-2 py-0.5 rounded-full bg-s2 border border-hair text-lime-t text-[10px] font-semibold uppercase tracking-wide">
              Reflect
            </span>
          ) : null}
          <span
            className="ml-auto tabular-nums font-semibold"
            style={{ color: chg.stroke }}
          >
            {pctLabel}
          </span>
        </span>
      </span>
    </>
  )

  if (preview || !address) {
    return <div className={frame}>{body}</div>
  }
  return (
    <Link href={`/token/${address}`} className={frame}>
      {body}
    </Link>
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
        className="relative w-24 shrink-0 flex items-center justify-center overflow-hidden"
        style={{ background: img ? undefined : tile }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 70% 50%, rgba(47, 132, 219, 0.28) 0%, transparent 70%)',
          }}
        />
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
