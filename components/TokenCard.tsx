'use client'

import Link from 'next/link'
import { Check, Copy } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { PoolToken } from '@/lib/tokens'
import { isReflectionToken, volumeForWindow } from '@/lib/tokens'
import { LaunchKindBadge } from '@/components/LaunchKindBadge'
import { ageLabel, changeParts, fmtUsd, sparkPathFromValues, tileGradient } from '@/lib/ui-format'
import { cdnImage } from '@/lib/cdn-image'
import { quoteAsset } from '@/lib/quote-assets'
import { EVE_TOKEN } from '@/lib/eve'

function isPlatformToken(token: PoolToken): boolean {
  return (token.coinType || '').toLowerCase() === EVE_TOKEN.toLowerCase()
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
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt)
  const quote = quoteAsset(token.instantMeta?.quote)
  const vol = volumeForWindow(token, '24H')
  const spark = sparkPathFromValues(token.sparkCloses ?? [])
  const up = (token.priceChange24h ?? 0) >= 0
  const pct = token.priceChange24h ?? 0
  const pctLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  const [copied, setCopied] = useState(false)
  const platform = isPlatformToken(token)
  const reflect = isReflectionToken(token)

  const copy = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!address || preview) return
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const body = (
    <>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-2/5 pair-watermark" aria-hidden>
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 80% 70% at 80% 50%, rgb(${quote.tint} / 0.18), transparent 72%)`,
          }}
        />
        {quote.mark ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={quote.mark}
            alt=""
            className="absolute right-3 top-1/2 size-24 -translate-y-1/2 rounded-full object-cover opacity-80"
          />
        ) : img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${address}-wm`}
            src={cdnImage(img, 320)}
            alt=""
            className="tile-art tile-media-in absolute inset-0 size-full object-cover"
          />
        ) : (
          <span
            className="absolute right-2 top-1/2 -translate-y-1/2 text-7xl font-bold leading-none opacity-10"
            style={{ color: mono }}
          >
            {initial}
          </span>
        )}
      </div>

      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="size-9 shrink-0 overflow-hidden rounded-full shadow-[0_0_0_1px_rgb(255_255_255_/_0.12)] flex items-center justify-center"
            style={{ background: img ? undefined : tile }}
          >
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${address}-av`}
                src={cdnImage(img, 96)}
                alt=""
                className="size-full object-cover object-center tile-media-in"
              />
            ) : (
              <span className="text-xs font-semibold" style={{ color: mono }}>
                {initial}
              </span>
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold tracking-tight">
              ${token.symbol || 'TOKEN'}
            </div>
            <div className="truncate text-xs text-t2">{token.name || 'Unnamed'}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {platform ? (
            <span className="rounded-full bg-lime/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-lime-t">
              Platform
            </span>
          ) : reflect ? (
            <span className="rounded-full bg-fun/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fun">
              Reflect
            </span>
          ) : null}
          <button
            type="button"
            onClick={copy}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.04] px-2 text-[11px] text-t3 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)] hover:text-white"
            aria-label="Copy contract address"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            CA
          </button>
        </div>
      </div>

      <div className="relative mt-3 max-w-[70%]">
        <div className="text-[1.45rem] font-semibold leading-none tracking-tight tabular-nums">
          {fmtUsd(token.marketCap)}
        </div>
        <div className="mt-1 text-[11px] text-t3">market cap</div>
      </div>

      <div className="relative mt-3 flex flex-wrap items-center gap-1.5 text-xs text-t2">
        <span>Paired with</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-s2 py-0.5 pl-1 pr-2 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
          {quote.mark ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={quote.mark} alt="" className="size-3.5 rounded-full object-cover" />
          ) : (
            <QuoteMark />
          )}
          <span className="text-white">{quote.symbol}</span>
        </span>
        {quote.kind !== 'usdc' ? (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{
              background: `rgb(${quote.tint} / 0.14)`,
              color: `rgb(${quote.tint})`,
            }}
          >
            {quote.label}
          </span>
        ) : (
          <span className="rounded-full bg-s2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-t2">
            USDC
          </span>
        )}
        {token.rewardsHandle ? (
          <span className="rounded-full bg-s2 px-2 py-0.5 text-[10px] font-semibold text-lime-t shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
            @{token.rewardsHandle}
          </span>
        ) : null}
      </div>

      <div className="relative mt-3 flex items-end justify-between gap-2">
        <div className="text-[11px] text-t3">
          Vol 24h <span className="tabular-nums text-t2">{fmtUsd(vol)}</span>
          <span className={`ml-1.5 font-semibold tabular-nums ${up ? 'text-up' : 'text-down'}`}>
            {pctLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {spark ? (
            <svg viewBox="0 0 100 30" className="h-5 w-12 opacity-80" aria-hidden>
              <path
                d={spark}
                fill="none"
                stroke={up ? 'var(--up)' : 'var(--down)'}
                strokeWidth="1.6"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          ) : null}
          <span className="text-[11px] tabular-nums text-t3">{age} ago</span>
        </div>
      </div>
    </>
  )

  const frame = 'token-tile group relative block overflow-hidden rounded-2xl p-4'

  if (preview || !address) {
    return <div className={frame}>{body}</div>
  }
  return (
    <Link href={`/token/${address}`} className={frame}>
      {body}
    </Link>
  )
}

function QuoteMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-lime-t" aria-hidden>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <circle cx="8" cy="8" r="5.2" fill="var(--bg)" />
      <text x="8" y="11" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor">
        $
      </text>
    </svg>
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
      className="token-tile flex-none w-[300px] flex items-stretch rounded-[20px] overflow-hidden"
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
