'use client'

/**
 * Token detail — Stocks-style hero, stats grid, chart, volume, activity tape, sticky trade panel.
 */
import { useParams } from 'next/navigation'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { type Address } from 'viem'
import Link from 'next/link'
import { Loader2, ExternalLink, Copy, Check, Globe } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import type { EvmTrade, EvmTradesResult } from '@/lib/evm-trades'
import type { EvmHoldersResult } from '@/lib/evm-holders'
import { ArcDexTradePanel } from '@/components/ArcDexTradePanel'
import { TokenChart, type HoverCandle } from '@/components/TokenChart'
import { LaunchKindBadge } from '@/components/LaunchKindBadge'
import type { TraderMeta } from '@/lib/arc-trader-meta'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { coalescedFetch } from '@/lib/coalesced-fetch'
import { buildCandles, priceChangeFromTrades, RANGE_BUCKET_SEC, scaleCandles } from '@/lib/candles'
import {
  ageLabel,
  changeParts,
  fmtPrice,
  fmtUsd,
  shortAddr,
  tileGradient,
  walletHue,
} from '@/lib/ui-format'

type Tab = 'Activity' | 'holders'
type Range = '5M' | '15M' | '1H' | '1D' | '1W'
type VolRange = '1H' | '6H' | '24H'
type ChartScale = 'FDV' | 'Price'

function twitterHref(raw: string): string {
  const t = raw.trim().replace(/^@/, '')
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  const handle = t.replace(/^(https?:\/\/)?(www\.)?(twitter|x)\.com\//i, '').split(/[/?#]/)[0]
  return handle ? `https://x.com/${handle}` : ''
}

function telegramHref(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  const path = t.replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, '').replace(/^@/, '')
  return path ? `https://t.me/${path}` : ''
}

function websiteHref(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}


const BURN_ADDRESS = '0x000000000000000000000000000000000000dead'

function fmtBurnedPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—'
  if (p <= 0) return '0%'
  if (p < 0.1) return '<0.1%'
  if (p >= 99.95) return '100%'
  return `${p.toFixed(1)}%`
}

/** Activity tape only — pools.trade style: 25/page, hard cap 50 rows. Chart uses the full KV tape. */
const ACT_PAGE_SIZE = 25
const ACT_MAX_ROWS = 50

export default function TokenPage() {
  const params = useParams()
  const token = ((params?.address as string) ?? '') as Address

  const [pool, setPool] = useState<PoolToken | null>(null)
  const [trades, setTrades] = useState<EvmTradesResult | null>(null)
  const [chartTape, setChartTape] = useState<EvmTrade[]>([])
  const [holders, setHolders] = useState<EvmHoldersResult | null>(null)
  const [traderMeta, setTraderMeta] = useState<Record<string, TraderMeta>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('Activity')
  const [range, setRange] = useState<Range>('5M')
  const [chartScale, setChartScale] = useState<ChartScale>('FDV')
  const [hoverCandle, setHoverCandle] = useState<HoverCandle | null>(null)
  const [volRange, setVolRange] = useState<VolRange>('1H')
  const [copied, setCopied] = useState(false)
  const [actPage, setActPage] = useState(0)

  const copyAddress = useCallback(() => {
    if (!token) return
    navigator.clipboard
      .writeText(token)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [token])

  const load = useCallback(async () => {
    if (!token) return
    try {
      const res = await coalescedFetch(`/api/arc/${token}`)
      if (res.ok) setPool((await res.json()) as PoolToken)
    } catch {
      /* keep prior */
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadTrades = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(
        `/api/arc/${token}/trades?limit=${ACT_PAGE_SIZE}&offset=${actPage * ACT_PAGE_SIZE}`,
        { cache: 'no-store' },
      )
      if (res.ok) setTrades((await res.json()) as EvmTradesResult)
    } catch {
      /* keep prior */
    }
  }, [token, actPage])

  const loadChartTape = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`/api/arc/${token}/trades?limit=400`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as EvmTradesResult
      setChartTape(data.trades ?? [])
    } catch {
      /* keep prior */
    }
  }, [token])

  const loadHolders = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`/api/arc/${token}/holders`, { cache: 'no-store' })
      if (res.ok) setHolders((await res.json()) as EvmHoldersResult)
    } catch {
      /* keep prior */
    }
  }, [token])

  const refreshAfterTrade = useCallback(() => {
    load()
    void loadTrades()
    void loadChartTape()
    void loadHolders()
  }, [load, loadTrades, loadChartTape, loadHolders])

  useEffect(() => {
    load()
    void loadTrades()
    void loadChartTape()
    void loadHolders()
  }, [load, loadTrades, loadChartTape, loadHolders])

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      load()
      void loadTrades()
      void loadChartTape()
    }, 8_000)
    return () => clearInterval(id)
  }, [load, loadTrades, loadChartTape])

  // Opt-in activity PFPs: only wallets with ArcFun profile + avatarUrl
  useEffect(() => {
    const list = trades?.trades ?? []
    if (list.length === 0) {
      setTraderMeta({})
      return
    }
    const addrs = Array.from(new Set(list.map((t) => t.trader.toLowerCase()).filter(Boolean)))
    if (addrs.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/arc/traders/meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addresses: addrs }),
        })
        if (!res.ok) return
        const data = (await res.json()) as { traders?: Record<string, TraderMeta> }
        if (!cancelled) setTraderMeta(data.traders || {})
      } catch {
        /* keep prior */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trades])

  const volWindowSec = useMemo(() => {
    if (volRange === '1H') return 3600
    if (volRange === '6H') return 6 * 3600
    return 86_400
  }, [volRange])

  const tape = chartTape.length ? chartTape : (trades?.trades ?? [])

  const { vol, buys, sells, buyUsd, sellUsd } = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - volWindowSec
    let vol = 0
    let buys = 0
    let sells = 0
    let buyUsd = 0
    let sellUsd = 0
    for (const t of tape) {
      if (t.ts < cutoff) continue
      vol += t.valueUsd
      if (t.isBuy) {
        buys++
        buyUsd += t.valueUsd
      } else {
        sells++
        sellUsd += t.valueUsd
      }
    }
    return { vol, buys, sells, buyUsd, sellUsd }
  }, [tape, volWindowSec])

  const vol24 = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - 86_400
    let tapeVol = 0
    let buyUsd = 0
    for (const t of tape) {
      if (t.ts < cutoff) continue
      tapeVol += t.valueUsd
      if (t.isBuy) buyUsd += t.valueUsd
    }
    const indexed = pool?.volume24h ?? 0
    return {
      vol: Math.max(tapeVol, indexed),
      buyPct: tapeVol > 0 ? (buyUsd / tapeVol) * 100 : 0,
    }
  }, [tape, pool?.volume24h])

  const buyPct = vol > 0 ? (buyUsd / vol) * 100 : 0
  const sellPct = vol > 0 ? 100 - buyPct : 0

  const explorer = ARC_EXPLORER || 'https://arc-scan.org'
  const seed = token || pool?.symbol || 'arc'
  const { tile, mono } = tileGradient(seed)
  const tapeChange = useMemo(() => priceChangeFromTrades(chartTape), [chartTape])
  const chg = changeParts(chartTape.length >= 2 ? tapeChange : pool?.priceChange24h)
  const supply = useMemo(() => {
    if (pool && pool.totalSupply > 1) return pool.totalSupply
    if (pool && pool.currentPrice > 0 && pool.marketCap > 0) return pool.marketCap / pool.currentPrice
    return 1_000_000_000
  }, [pool])
  const candles = useMemo(() => {
    const raw = buildCandles(chartTape, RANGE_BUCKET_SEC[range], pool?.currentPrice ?? 0)
    return chartScale === 'FDV' ? scaleCandles(raw, supply) : raw
  }, [chartTape, range, pool?.currentPrice, chartScale, supply])
  const lastCandle = candles[candles.length - 1]
  const shown = hoverCandle ?? (lastCandle ? { ...lastCandle, up: lastCandle.close >= lastCandle.open } : null)
  const axisFmt = chartScale === 'FDV' ? fmtUsd : fmtPrice

  const holderCount = holders?.total ?? holders?.holders?.length ?? 0
  const actTabs: { id: Tab; label: string }[] = [
    { id: 'Activity', label: 'Activity' },
    { id: 'holders', label: holderCount ? `${holderCount} holders` : 'Holders' },
  ]

  if (loading && !pool) {
    return (
      <main className="min-h-screen text-white flex items-center justify-center pt-16">
        <Loader2 className="w-8 h-8 animate-spin text-lime-t" />
      </main>
    )
  }

  if (!pool) {
    return (
      <main className="min-h-screen text-white flex flex-col items-center justify-center gap-4 px-4 pt-16">
        <p className="text-t2">Token not found on Arc.</p>
        <Link href="/create" className="text-lime-t hover:text-white text-sm font-semibold">
          Launch on Arc
        </Link>
      </main>
    )
  }

  const initial = (pool.symbol || pool.name || '?').charAt(0).toUpperCase()
  const img = pool.imageUrl || pool.logoUrl
  const creator = pool.creatorShort || shortAddr(pool.creator)
  const xUrl = pool.twitter ? twitterHref(pool.twitter) : ''
  const tgUrl = pool.telegram ? telegramHref(pool.telegram) : ''
  const webUrl = pool.website ? websiteHref(pool.website) : ''
  const hasSocials = !!(xUrl || tgUrl || webUrl)

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_384px] gap-7 items-start">
          <div className="flex flex-col gap-5 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-[18px]">
              <span
                className="w-[72px] h-[72px] rounded-[24px] shrink-0 flex items-center justify-center text-[32px] font-bold tracking-[-0.04em] overflow-hidden relative"
                style={{ background: img ? undefined : tile, color: mono }}
              >
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img} alt="" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  initial
                )}
              </span>
              <div className="min-w-0 flex flex-col gap-2">
                <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] truncate">
                  {pool.name}
                </h1>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-sm font-semibold text-t2">${pool.symbol}</span>
                  <button
                    type="button"
                    onClick={copyAddress}
                    title={copied ? 'Copied!' : 'Copy contract address'}
                    className="text-sm text-t3 tabular-nums hover:text-t2 inline-flex items-center gap-1"
                  >
                    {shortAddr(token)}
                    {copied ? <Check className="w-3 h-3 text-lime-t" /> : <Copy className="w-3 h-3" />}
                  </button>
                  <a
                    href={`${explorer}/token/${token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on explorer"
                    className="text-t3 hover:text-t2 inline-flex items-center"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <LaunchKindBadge token={pool} size="md" />
                  {hasSocials && (
                    <span className="inline-flex items-center gap-1">
                      {xUrl ? (
                        <a
                          href={xUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="X / Twitter"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] bg-s2 border border-hair text-t2 hover:border-lime-line hover:text-white transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
                          </svg>
                        </a>
                      ) : null}
                      {tgUrl ? (
                        <a
                          href={tgUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Telegram"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] bg-s2 border border-hair text-t2 hover:border-lime-line hover:text-white transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                          </svg>
                        </a>
                      ) : null}
                      {webUrl ? (
                        <a
                          href={webUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Website"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] bg-s2 border border-hair text-t2 hover:border-lime-line hover:text-white transition-colors"
                        >
                          <Globe className="w-3.5 h-3.5" />
                        </a>
                      ) : null}
                    </span>
                  )}
                  {pool.creator && (
                    <Link
                      href={`/creator/${pool.creator}`}
                      className="px-2.5 py-1 rounded-[9px] bg-s2 border border-hair text-xs font-medium text-t2 whitespace-nowrap hover:border-lime-line hover:text-lime-t transition-colors"
                      title="View creator profile"
                    >
                      {creator}
                    </Link>
                  )}
                </div>
              </div>
            </div>

            {/* FDV + change */}
            <div className="flex items-end gap-4 pt-1">
              <span className="text-[48px] sm:text-[56px] font-bold tracking-display leading-[0.92] tabular-nums">
                {fmtUsd(pool.marketCap)}
              </span>
              <span
                className="px-3 py-1.5 rounded-[11px] text-[15px] font-bold tabular-nums whitespace-nowrap mb-1"
                style={{ background: chg.chipBg, color: chg.chipFg }}
              >
                {chg.label}
              </span>
              <span className="text-[13px] text-t3 mb-2 hidden sm:inline">
                fully diluted · past {range}
              </span>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-hair2 border border-hair rounded-[24px] overflow-hidden">
              {[
                {
                  label: 'Burned',
                  value: fmtBurnedPct(pool.burnedPct),
                  sub: 'of supply',
                  subColor: 'var(--limeT)',
                  bar: pool.burnedPct,
                  href: `${explorer}/token/${token}?a=${BURN_ADDRESS}`,
                },
                {
                  label: '24H volume',
                  value: fmtUsd(vol24.vol),
                  sub: vol24.vol > 0 ? `${vol24.buyPct.toFixed(1)}% buys` : 'no trades',
                  subColor: 'var(--limeT)',
                  bar: null,
                  href: null,
                },
                {
                  label: 'Liquidity',
                  value:
                    pool.liquidityQuoteUsd != null && pool.liquidityQuoteUsd > 0
                      ? fmtUsd(pool.liquidityQuoteUsd)
                      : '—',
                  sub: 'USDC in pool',
                  subColor: 'var(--t3)',
                  bar: null,
                  href: null,
                },
                {
                  label: 'Holders',
                  value: holderCount ? String(holderCount) : '—',
                  sub: 'on Arc',
                  subColor: 'var(--limeT)',
                  bar: null,
                  href: null,
                },
              ].map((m) => {
                const inner = (
                  <>
                    <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 whitespace-nowrap inline-flex items-center gap-1">
                      {m.label}
                      {m.href ? <ExternalLink className="w-3 h-3" /> : null}
                    </span>
                    <span className="text-2xl font-semibold tabular-nums tracking-[-0.028em] leading-tight truncate">
                      {m.value}
                    </span>
                    {m.bar != null && Number.isFinite(m.bar) ? (
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, m.bar))}%`,
                            background: 'var(--limeT)',
                          }}
                        />
                      </div>
                    ) : null}
                    <span className="text-xs font-semibold tabular-nums" style={{ color: m.subColor }}>
                      {m.sub}
                    </span>
                  </>
                )
                const cls = 'px-5 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0'
                return m.href ? (
                  <a
                    key={m.label}
                    href={m.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View burned supply on explorer"
                    className={`${cls} hover:bg-s2 transition-colors`}
                  >
                    {inner}
                  </a>
                ) : (
                  <div key={m.label} className={cls}>
                    {inner}
                  </div>
                )
              })}
            </div>

            {/* Chart — pools.trade layout: OHLC + FDV/interval + candles + volume */}
            <div className="border border-hair rounded-[28px] bg-[#131313] px-4 pt-4 pb-2 overflow-hidden">
              <div className="flex items-center justify-between gap-4 flex-wrap px-2">
                <div
                  className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] font-semibold tabular-nums"
                  style={{ color: shown?.up === false ? '#F0616D' : '#40B66B' }}
                >
                  <span>
                    O <span className="text-inherit">{shown ? axisFmt(shown.open) : '—'}</span>
                  </span>
                  <span>
                    H <span className="text-inherit">{shown ? axisFmt(shown.high) : '—'}</span>
                  </span>
                  <span>
                    L <span className="text-inherit">{shown ? axisFmt(shown.low) : '—'}</span>
                  </span>
                  <span>
                    C <span className="text-inherit">{shown ? axisFmt(shown.close) : '—'}</span>
                  </span>
                  <span className="text-white/45">
                    V <span className="text-white/70">{shown ? fmtUsd(shown.volume) : '$0'}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1 p-1 bg-white/5 border border-white/10 rounded-xl">
                    {(['FDV', 'Price'] as ChartScale[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setChartScale(s)}
                        className="px-3 py-1.5 rounded-[9px] text-xs font-semibold transition-colors"
                        style={{
                          background: chartScale === s ? 'rgba(255,255,255,0.12)' : 'transparent',
                          color: chartScale === s ? '#fff' : 'rgba(255,255,255,0.52)',
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1 p-1 bg-white/5 border border-white/10 rounded-xl">
                    {(['5M', '15M', '1H', '1D', '1W'] as Range[]).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRange(r)}
                        className="px-3 py-1.5 rounded-[9px] text-xs font-semibold transition-colors"
                        style={{
                          background: range === r ? 'rgba(255,255,255,0.12)' : 'transparent',
                          color: range === r ? '#fff' : 'rgba(255,255,255,0.52)',
                        }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="relative mt-2 rounded-xl overflow-hidden">
                <TokenChart
                  candles={candles}
                  height={360}
                  bucketSec={RANGE_BUCKET_SEC[range]}
                  onHover={(c) => {
                    if (!c) {
                      setHoverCandle(null)
                      return
                    }
                    const match = candles.find((x) => x.time === c.time)
                    setHoverCandle(match ? { ...c, volume: match.volume } : c)
                  }}
                />
              </div>
            </div>

            {/* Volume */}
            <div id="activity" className="border border-hair rounded-[28px] bg-s1 p-[22px] px-6">
              <div className="flex items-start justify-between gap-5">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
                    Volume
                  </span>
                  <span className="text-[30px] font-semibold tabular-nums tracking-[-0.03em]">
                    {fmtUsd(vol)}
                  </span>
                </div>
                <div className="flex gap-1 p-1 bg-s2 border border-hair rounded-xl">
                  {(['1H', '6H', '24H'] as VolRange[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVolRange(v)}
                      className="px-3.5 py-1.5 rounded-[9px] text-xs font-semibold transition-colors"
                      style={{
                        background: volRange === v ? 'rgba(255,255,255,0.12)' : 'transparent',
                        color: volRange === v ? '#fff' : 'rgba(255,255,255,0.52)',
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1 mt-[18px]">
                <span
                  className="h-2 rounded-full bg-lime"
                  style={{ width: `${Math.max(4, buyPct)}%` }}
                />
                <span className="h-2 rounded-full bg-coral flex-1" />
              </div>
              <div className="flex justify-between mt-3.5">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-lime-t">{buys} buys</span>
                  <span className="text-[13px] text-t3 tabular-nums">
                    {fmtUsd(buyUsd)} · {buyPct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex flex-col gap-1 text-right">
                  <span className="text-sm font-semibold text-coral">{sells} sells</span>
                  <span className="text-[13px] text-t3 tabular-nums">
                    {fmtUsd(sellUsd)} · {sellPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Activity / holders */}
            <div className="border border-hair rounded-[28px] bg-s1 overflow-hidden">
              <div className="px-6 pt-5 flex items-center gap-5 sm:gap-6 overflow-x-auto">
                {actTabs.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setTab(a.id)}
                    className="pb-3.5 text-lg sm:text-[19px] font-semibold tracking-tightish whitespace-nowrap border-b-2 transition-colors"
                    style={{
                      borderColor: tab === a.id ? 'var(--limeT)' : 'transparent',
                      color: tab === a.id ? '#fff' : 'var(--t3)',
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="h-px bg-hair2" />

              {tab === 'Activity' && (
                <div className="px-3 pb-2 pt-4">
                  <div className="grid grid-cols-[1.4fr_.7fr_1fr_1fr_.8fr] gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
                    <span>Wallet</span>
                    <span>Type</span>
                    <span>Amount</span>
                    <span>Tokens</span>
                    <span className="text-right">Time</span>
                  </div>
                  {!(trades?.trades?.length) ? (
                    <p className="text-sm text-t3 text-center py-10">
                      {actPage > 0 ? 'No more trades.' : 'No trades yet.'}
                    </p>
                  ) : (
                    trades!.trades.map((t, i) => {
                      const tm = traderMeta[t.trader.toLowerCase()]
                      return (
                      <div
                        key={`${t.txHash}-${i}`}
                        className="grid grid-cols-[1.4fr_.7fr_1fr_1fr_.8fr] gap-3 px-3 py-3.5 border-b border-hair2 text-sm items-center tabular-nums hover:bg-white/[0.02]"
                      >
                        <a
                          href={`${explorer}/address/${t.trader}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2.5 min-w-0 hover:text-white"
                          title="View wallet on explorer"
                        >
                          {tm?.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={tm.avatarUrl}
                              alt=""
                              className="w-[18px] h-[18px] rounded-full shrink-0 object-cover border"
                              style={{
                                borderColor: t.isBuy ? 'var(--limeT)' : 'var(--coral)',
                              }}
                            />
                          ) : (
                            <span
                              className="w-[18px] h-[18px] rounded-full shrink-0"
                              style={{ background: walletHue(t.trader) }}
                            />
                          )}
                          <span className="text-t2 truncate">
                            {tm?.twitter
                              ? `@${tm.twitter}`
                              : tm?.displayName || shortAddr(t.trader)}
                          </span>
                        </a>
                        <a
                          href={`${explorer}/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold"
                          style={{ color: t.isBuy ? 'var(--limeT)' : 'var(--coral)' }}
                          title="View transaction"
                        >
                          {t.isBuy ? 'Buy' : 'Sell'}
                        </a>
                        <a
                          href={`${explorer}/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium hover:text-white"
                        >
                          {fmtUsd(t.valueUsd)}
                        </a>
                        <a
                          href={`${explorer}/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-t2 truncate hover:text-white"
                        >
                          {t.tokenAmount != null ? String(t.tokenAmount) : '—'}
                        </a>
                        <a
                          href={`${explorer}/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-right text-t3 text-[13px] hover:text-white"
                        >
                          {ageLabel(t.ts)} ago
                        </a>
                      </div>
                    )})
                  )}
                  {((trades?.trades?.length ?? 0) > 0 || actPage > 0) && (
                    <div className="flex items-center justify-between pt-3 px-1">
                      <button
                        type="button"
                        disabled={actPage === 0}
                        onClick={() => setActPage((p) => Math.max(0, p - 1))}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-t2 border border-hair disabled:opacity-30 disabled:pointer-events-none hover:border-lime-line hover:text-white transition-colors"
                      >
                        ← Prev
                      </button>
                      <span className="text-xs text-t3">
                        Page {actPage + 1} of{' '}
                        {Math.max(
                          1,
                          Math.min(
                            Math.ceil(ACT_MAX_ROWS / ACT_PAGE_SIZE),
                            trades?.total != null
                              ? Math.max(1, Math.ceil(Math.min(trades.total, ACT_MAX_ROWS) / ACT_PAGE_SIZE))
                              : actPage + 1,
                          ),
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={
                          (actPage + 1) * ACT_PAGE_SIZE >= ACT_MAX_ROWS ||
                          (trades?.total != null
                            ? (actPage + 1) * ACT_PAGE_SIZE >= trades.total
                            : (trades?.trades?.length ?? 0) < ACT_PAGE_SIZE)
                        }
                        onClick={() => setActPage((p) => p + 1)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-t2 border border-hair disabled:opacity-30 disabled:pointer-events-none hover:border-lime-line hover:text-white transition-colors"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {tab === 'holders' && (
                <div className="px-3 pb-2 pt-4">
                  {!(holders?.holders?.length) ? (
                    <p className="text-sm text-t3 text-center py-10">No holders indexed yet.</p>
                  ) : (
                    holders!.holders.map((h) => (
                      <a
                        key={h.address}
                        href={`${explorer}/address/${h.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between px-3 py-3.5 border-b border-hair2 text-sm hover:bg-white/[0.02]"
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-t3 tabular-nums w-8">#{h.rank}</span>
                          <span
                            className="w-[18px] h-[18px] rounded-full"
                            style={{ background: walletHue(h.address) }}
                          />
                          <span className="font-mono text-t2">
                            {shortAddr(h.address)}
                            {h.isDev ? <span className="ml-1.5 text-amber-400">dev</span> : null}
                          </span>
                        </span>
                        <span className="tabular-nums text-t2">
                          {h.balance} · {h.percentage}%
                        </span>
                      </a>
                    ))
                  )}
                </div>
              )}

            </div>
          </div>

          {/* Trade panel */}
          <div className="lg:sticky lg:top-[88px]">
            <ArcDexTradePanel
              token={token}
              symbol={pool.symbol}
              onTraded={refreshAfterTrade}
            />
            {pool.description && (
              <p className="mt-4 px-2 text-[13px] text-t3 leading-relaxed">{pool.description}</p>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
