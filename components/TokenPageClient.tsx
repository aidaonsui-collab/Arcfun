'use client'

/**
 * Token detail — Stocks-style hero, stats grid, chart, volume, activity tape, sticky trade panel.
 *
 * First HTML comes from a catalog snapshot (name/symbol/image/price). Live `/api/arc/[token]`
 * overlays after hydration. Holders RPC and the 400-row chart tape stay off the first paint.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import nextDynamic from 'next/dynamic'
import { type Address } from 'viem'
import Link from 'next/link'
import { Loader2, ExternalLink, Copy, Check, Globe, Filter } from 'lucide-react'
import { isReflectionToken, type PoolToken } from '@/lib/tokens'
import type { EvmTrade, EvmTradesResult } from '@/lib/evm-trades'
import type { EvmHoldersResult } from '@/lib/evm-holders'
import { ArcDexTradePanel } from '@/components/ArcDexTradePanel'
import type { TraderMeta } from '@/lib/arc-trader-meta'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { coalescedFetch } from '@/lib/coalesced-fetch'
import { arcMarketCapUsd } from '@/lib/arc-instant-tokens'
import { priceChangeFromTrades } from '@/lib/candles'
import { telegramHref, twitterHref, websiteHref } from '@/lib/social-href'
import { cdnImage } from '@/lib/cdn-image'
import { TokenListingEdit } from '@/components/TokenListingEdit'

const TradingViewChart = nextDynamic(() => import('@/components/TradingViewChart'), {
  ssr: false,
})
import {
  ageLabel,
  fmtCompact,
  fmtPrice,
  fmtUsd,
  shortAddr,
  tileGradient,
  walletHue,
} from '@/lib/ui-format'

type Tab = 'Activity' | 'holders'




const BURN_ADDRESS = '0x000000000000000000000000000000000000dead'

function fmtTapeTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  if (n < 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return Math.round(n).toLocaleString()
}

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

export function TokenPageClient({
  address,
  initialPool,
}: {
  address: string
  initialPool: PoolToken | null
}) {
  const token = (address || '') as Address

  const [pool, setPool] = useState<PoolToken | null>(initialPool)
  const [trades, setTrades] = useState<EvmTradesResult | null>(null)
  const [chartTape, setChartTape] = useState<EvmTrade[]>([])
  const [holders, setHolders] = useState<EvmHoldersResult | null>(null)
  const [traderMeta, setTraderMeta] = useState<Record<string, TraderMeta>>({})
  const [loading, setLoading] = useState(!initialPool)
  const [tab, setTab] = useState<Tab>('Activity')
  const [copied, setCopied] = useState(false)
  const [actPage, setActPage] = useState(0)
  const [walletFilter, setWalletFilter] = useState<string | null>(null)
  const [copiedTrader, setCopiedTrader] = useState<string | null>(null)
  const [holdersLoading, setHoldersLoading] = useState(false)
  const [chartReady, setChartReady] = useState(false)
  const listingEpoch = useRef(0)

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

  const mergePool = useCallback((next: PoolToken) => {
    setPool((prev) => {
      if (!prev) return next
      const keep = (n?: string, p?: string) => (n && n.trim()) || p || ''
      return {
        ...next,
        imageUrl: keep(next.imageUrl, prev.imageUrl),
        logoUrl: keep(next.logoUrl || next.imageUrl, prev.logoUrl || prev.imageUrl),
        twitter: keep(next.twitter, prev.twitter),
        telegram: keep(next.telegram, prev.telegram),
        website: keep(next.website, prev.website),
        description: keep(next.description, prev.description),
        streamUrl: keep(next.streamUrl, prev.streamUrl),
        liquidityUsd: next.liquidityUsd ?? prev.liquidityUsd,
        liquidityQuoteUsd: next.liquidityQuoteUsd ?? prev.liquidityQuoteUsd,
        burnedPct: next.burnedPct ?? prev.burnedPct,
      }
    })
  }, [])

  const load = useCallback(async () => {
    if (!token) return
    const epoch = listingEpoch.current
    try {
      const res = await coalescedFetch(`/api/arc/${token}`)
      if (listingEpoch.current !== epoch) return
      if (res.ok) mergePool((await res.json()) as PoolToken)
    } catch {
      /* keep prior */
    } finally {
      if (listingEpoch.current === epoch) setLoading(false)
    }
  }, [token, mergePool])

  const loadStats = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`/api/arc/${token}?full=1`)
      if (res.ok) mergePool((await res.json()) as PoolToken)
    } catch {
      /* keep prior */
    }
  }, [token, mergePool])

  const loadTrades = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(
        `/api/arc/${token}/trades?limit=${ACT_PAGE_SIZE}&offset=${actPage * ACT_PAGE_SIZE}`,
      )
      if (res.ok) setTrades((await res.json()) as EvmTradesResult)
    } catch {
      /* keep prior */
    }
  }, [token, actPage])

  const loadChartTape = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`/api/arc/${token}/trades?limit=400`)
      if (!res.ok) return
      const data = (await res.json()) as EvmTradesResult
      setChartTape(data.trades ?? [])
    } catch {
      /* keep prior */
    }
  }, [token])

  const loadHolders = useCallback(async () => {
    if (!token) return
    setHoldersLoading(true)
    try {
      const res = await fetch(`/api/arc/${token}/holders`)
      if (res.ok) setHolders((await res.json()) as EvmHoldersResult)
    } catch {
      /* keep prior */
    } finally {
      setHoldersLoading(false)
    }
  }, [token])

  const refreshAfterTrade = useCallback(() => {
    load()
    void loadStats()
    void loadTrades()
    if (chartReady) void loadChartTape()
    if (tab === 'holders') void loadHolders()
  }, [load, loadStats, loadTrades, loadChartTape, loadHolders, chartReady, tab])

  useEffect(() => {
    load()
    void loadTrades()
    void loadStats()
  }, [load, loadTrades, loadStats])

  useEffect(() => {
    if (!pool) return
    setChartReady(true)
  }, [pool])

  useEffect(() => {
    if (!chartReady) return
    void loadChartTape()
  }, [chartReady, loadChartTape])

  useEffect(() => {
    if (holders != null) return
    void loadHolders()
  }, [holders, loadHolders])

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      load()
      void loadTrades()
    }, 8_000)
    return () => clearInterval(id)
  }, [load, loadTrades])

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadStats()
    }, 60_000)
    return () => clearInterval(id)
  }, [loadStats])

  // Opt-in activity PFPs: only wallets with ArcFun profile + avatarUrl
  useEffect(() => {
    const list = trades?.trades ?? []
    if (list.length === 0 && !walletFilter) {
      setTraderMeta({})
      return
    }
    const addrs = Array.from(
      new Set(
        [
          ...list.map((t) => t.trader.toLowerCase()),
          ...(walletFilter ? [walletFilter.toLowerCase()] : []),
        ].filter(Boolean),
      ),
    )
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
  }, [trades, walletFilter])

  const tape = chartTape.length ? chartTape : (trades?.trades ?? [])
  const traderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tape) {
      const k = t.trader.toLowerCase()
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }, [tape])
  const activityTrades = useMemo(() => {
    const page = trades?.trades ?? []
    if (!walletFilter) return page
    const key = walletFilter.toLowerCase()
    return tape.filter((t) => t.trader.toLowerCase() === key)
  }, [walletFilter, trades, tape])

  const filterWallet = useCallback((addr: string) => {
    const key = addr.toLowerCase()
    setWalletFilter((prev) => (prev === key ? null : key))
    setActPage(0)
    setTab('Activity')
    void loadChartTape()
  }, [loadChartTape])

  const copyTrader = useCallback((addr: string) => {
    navigator.clipboard
      .writeText(addr)
      .then(() => {
        setCopiedTrader(addr.toLowerCase())
        setTimeout(() => setCopiedTrader(null), 1400)
      })
      .catch(() => {})
  }, [])

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

  const explorer = ARC_EXPLORER || 'https://arc-scan.org'
  const seed = token || pool?.symbol || 'arc'
  const { tile, mono } = tileGradient(seed)
  const tapeChange = useMemo(() => priceChangeFromTrades(chartTape), [chartTape])


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

  const quote = pool.instantMeta?.quote || 'USDC'
  const pct24 = chartTape.length >= 2 ? tapeChange : pool.priceChange24h
  const pctUp = (pct24 ?? 0) >= 0
  const pctLabel = `${pctUp ? '+' : ''}${(pct24 ?? 0).toFixed(1)}% 24h`

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-[1120px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-start gap-4">
              <span
                className="size-14 rounded-full shrink-0 flex items-center justify-center text-lg font-bold overflow-hidden relative border border-hair"
                style={{ background: img ? undefined : tile, color: mono }}
              >
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cdnImage(img, 128)} alt="" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  initial
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="m-0 text-xl font-semibold tracking-tight truncate">{pool.name}</h1>
                  <span className="text-t2">${pool.symbol}</span>
                  {isReflectionToken(pool) ? (
                    <span className="px-2 py-0.5 rounded-full bg-s2 border border-hair text-lime-t text-[10px] font-semibold uppercase tracking-wide">
                      Reflect
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-s2 border border-hair text-t2 text-[10px] font-semibold uppercase tracking-wide">
                      Meme
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <div className="text-4xl font-semibold tracking-tight tabular-nums">
                    {fmtUsd(pool.marketCap)}
                  </div>
                  <div
                    className="mb-1 text-sm tabular-nums"
                    style={{ color: pctUp ? 'var(--limeT)' : 'var(--coral)' }}
                  >
                    {pctLabel}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2.5 flex-wrap">
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
        <TokenListingEdit
          token={token}
          pool={pool}
          onSaved={(patch) => {
            listingEpoch.current += 1
            setPool((p) => (p ? { ...p, ...patch } : p))
          }}
        />

        <div className="mt-8 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
          <div className="flex flex-col gap-5 min-w-0">
            <div className="h-64 sm:h-72 rounded-[20px] bg-s1 border border-hair overflow-hidden">
              <TradingViewChart token={token} symbol={pool.symbol} height={288} />
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <TokenStat label="Price" value={fmtPrice(pool.currentPrice)} />
              <TokenStat label="24h volume" value={fmtUsd(vol24.vol)} />
              <TokenStat label="Holders" value={holderCount ? String(holderCount) : '—'} />
              <TokenStat label="Age" value={ageLabel(pool.createdAt)} />
            </dl>

            <div className="rounded-[20px] bg-s1 border border-hair p-5">
              <h2 className="m-0 text-sm font-medium">About</h2>
              {pool.description ? (
                <p className="mt-2 mb-0 text-sm leading-relaxed text-t2 text-pretty">{pool.description}</p>
              ) : (
                <p className="mt-2 mb-0 text-sm text-t3">No description.</p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-t3">
                <span className="inline-flex items-center gap-1.5">
                  Paired with
                  <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-lime-t text-[8px] font-bold text-[var(--bg)]">
                    $
                  </span>
                  {quote}
                </span>
                <span>·</span>
                <span>Supply {fmtCompact(pool.totalSupply)}</span>
                <span>·</span>
                <span>1% Uniswap V3 fee</span>
                {pool.burnedPct != null ? (
                  <>
                    <span>·</span>
                    <a
                      href={`${explorer}/token/${token}?a=${BURN_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-white"
                    >
                      Burned {fmtBurnedPct(pool.burnedPct)}
                    </a>
                  </>
                ) : null}
                {pool.liquidityQuoteUsd != null && pool.liquidityQuoteUsd > 0 ? (
                  <>
                    <span>·</span>
                    <span>Liq {fmtUsd(pool.liquidityQuoteUsd)}</span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Activity / holders */}
            <div id="activity" className="rounded-[20px] bg-s1 border border-hair overflow-hidden">
              <div className="px-5 pt-5 flex items-center gap-5 overflow-x-auto">
                {actTabs.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setTab(a.id)}
                    className="pb-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors"
                    style={{
                      borderColor: tab === a.id ? 'var(--lime)' : 'transparent',
                      color: tab === a.id ? '#fff' : 'var(--t3)',
                    }}
                  >
                    {a.id === 'Activity' ? 'Tape' : a.label}
                  </button>
                ))}
                <div className="ml-auto pb-3.5 flex items-center gap-2 shrink-0">
                  {walletFilter ? (
                    <button
                      type="button"
                      onClick={() => setWalletFilter(null)}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-lime-line bg-s2 text-[12px] font-semibold text-white hover:bg-s3"
                      title="Clear wallet filter"
                    >
                      {shortAddr(walletFilter)}
                      <span className="text-t3">×</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => walletFilter && setWalletFilter(null)}
                    title={
                      walletFilter
                        ? 'Clear wallet filter'
                        : 'Click the funnel on a wallet to see only its trades'
                    }
                    className={`h-7 w-7 inline-flex items-center justify-center rounded-lg border transition-colors ${
                      walletFilter
                        ? 'border-lime-line text-lime-t bg-s2'
                        : 'border-hair text-t3 hover:text-white hover:border-lime-line'
                    }`}
                  >
                    <Filter className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="h-px bg-hair2" />

              {tab === 'Activity' && (
                <div className="px-3 pb-2 pt-4">
                  <div className="grid grid-cols-[1.3fr_.6fr_.8fr_.7fr] sm:grid-cols-[1.4fr_.7fr_.9fr_.9fr_.8fr_.7fr] gap-2 sm:gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
                    <span>Wallet</span>
                    <span>Type</span>
                    <span>Amount</span>
                    <span className="hidden sm:block">Tokens</span>
                    <span className="hidden sm:block">MC</span>
                    <span className="text-right">Time</span>
                  </div>
                  {!activityTrades.length ? (
                    <p className="text-sm text-t3 text-center py-10">
                      {walletFilter
                        ? 'No recent trades from this wallet.'
                        : actPage > 0
                          ? 'No more trades.'
                          : 'No trades yet.'}
                    </p>
                  ) : (
                    activityTrades.map((t, i) => {
                      const tm = traderMeta[t.trader.toLowerCase()]
                      const traderKey = t.trader.toLowerCase()
                      const n = traderCounts.get(traderKey) || 0
                      const filtered = walletFilter === traderKey
                      return (
                      <div
                        key={`${t.txHash}-${i}`}
                        className="grid grid-cols-[1.3fr_.6fr_.8fr_.7fr] sm:grid-cols-[1.4fr_.7fr_.9fr_.9fr_.8fr_.7fr] gap-2 sm:gap-3 px-3 py-3.5 border-b border-hair2 text-sm items-center tabular-nums hover:bg-white/[0.02]"
                      >
                        <div className="flex items-center gap-2 min-w-0">
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
                              title={t.isBuy ? 'Buy' : 'Sell'}
                              style={{ background: t.isBuy ? 'var(--limeT)' : 'var(--coral)' }}
                            />
                          )}
                          <span className="text-t2 truncate min-w-0">
                            {tm?.twitter
                              ? `@${tm.twitter}`
                              : tm?.displayName || shortAddr(t.trader)}
                          </span>
                          {n > 1 ? (
                            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-t3 bg-s2 border border-hair rounded-md px-1.5 py-0.5">
                              {n}
                            </span>
                          ) : null}
                          <span className="ml-auto hidden sm:flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => filterWallet(t.trader)}
                              title={filtered ? 'Clear wallet filter' : 'Show only this wallet'}
                              className={`h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors ${
                                filtered
                                  ? 'text-lime-t bg-white/[0.06]'
                                  : 'text-t3 hover:text-white hover:bg-white/[0.06]'
                              }`}
                            >
                              <Filter className="w-3.5 h-3.5" />
                            </button>
                            <a
                              href={`${explorer}/address/${t.trader}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View wallet on explorer"
                              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-t3 hover:text-white hover:bg-white/[0.06]"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </span>
                        </div>
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
                          className="hidden sm:block text-t2 truncate hover:text-white"
                        >
                          {fmtTapeTokens(t.tokenAmount)}
                        </a>
                        <a
                          href={`${explorer}/tx/${t.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hidden sm:block font-medium text-t2 hover:text-white"
                          title="Market cap at this print"
                        >
                          {t.priceUsd > 0 ? fmtUsd(arcMarketCapUsd(t.priceUsd)) : '—'}
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
                  {!walletFilter && ((trades?.trades?.length ?? 0) > 0 || actPage > 0) && (
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
                  {holdersLoading && !(holders?.holders?.length) ? (
                    <div className="flex justify-center py-10">
                      <Loader2 className="w-6 h-6 animate-spin text-lime-t" />
                    </div>
                  ) : !(holders?.holders?.length) ? (
                    <p className="text-sm text-t3 text-center py-10">No holders indexed yet.</p>
                  ) : (
                    holders!.holders.map((h) => {
                      const key = h.address.toLowerCase()
                      const n = traderCounts.get(key) || 0
                      const filtered = walletFilter === key
                      return (
                      <div
                        key={h.address}
                        className="flex items-center justify-between gap-3 px-3 py-3.5 border-b border-hair2 text-sm hover:bg-white/[0.02]"
                      >
                        <span className="flex items-center gap-3 min-w-0">
                          <span className="text-t3 tabular-nums w-8 shrink-0">#{h.rank}</span>
                          <span
                            className="w-[18px] h-[18px] rounded-full shrink-0"
                            style={{ background: walletHue(h.address) }}
                          />
                          <span className="font-mono text-t2 truncate">
                            {shortAddr(h.address)}
                            {h.isDev ? <span className="ml-1.5 text-amber-400">dev</span> : null}
                          </span>
                          {n > 0 ? (
                            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-t3 bg-s2 border border-hair rounded-md px-1.5 py-0.5">
                              {n}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="tabular-nums text-t2 text-right">
                            {h.balance} · {h.percentage}%
                          </span>
                          <span className="hidden sm:flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => filterWallet(h.address)}
                              title={filtered ? 'Clear wallet filter' : "Show this wallet's trades"}
                              className={`h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors ${
                                filtered
                                  ? 'text-lime-t bg-white/[0.06]'
                                  : 'text-t3 hover:text-white hover:bg-white/[0.06]'
                              }`}
                            >
                              <Filter className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => copyTrader(h.address)}
                              title="Copy address"
                              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-t3 hover:text-white hover:bg-white/[0.06]"
                            >
                              {copiedTrader === key ? (
                                <Check className="w-3.5 h-3.5 text-lime-t" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <a
                              href={`${explorer}/address/${h.address}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View wallet on explorer"
                              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-t3 hover:text-white hover:bg-white/[0.06]"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </span>
                        </span>
                      </div>
                    )})
                  )}
                </div>
              )}

            </div>
          </div>

          <div className="lg:sticky lg:top-20 lg:self-start">
            <ArcDexTradePanel
              token={token}
              symbol={pool.symbol}
              imageUrl={pool.imageUrl || pool.logoUrl}
              onTraded={refreshAfterTrade}
            />
          </div>
        </div>
      </div>
    </main>
  )
}

function TokenStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-s1 border border-hair px-4 py-3">
      <div className="text-[11px] text-t3">{label}</div>
      <div className="mt-1 text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}
