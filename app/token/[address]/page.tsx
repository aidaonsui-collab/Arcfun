'use client'

/**
 * Token detail — Stocks-style hero, stats grid, chart, volume, activity tape, sticky trade panel.
 */
import { useParams } from 'next/navigation'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { type Address } from 'viem'
import Link from 'next/link'
import { Loader2, ExternalLink, Copy, Check } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import type { EvmTradesResult } from '@/lib/evm-trades'
import type { EvmHoldersResult } from '@/lib/evm-holders'
import { ArcDexTradePanel } from '@/components/ArcDexTradePanel'
import { TokenChart, type ChartTradeMarker } from '@/components/TokenChart'
import type { TraderMeta } from '@/lib/arc-trader-meta'
import { ARC_EXPLORER, ARC } from '@/lib/contracts-arc'
import { coalescedFetch } from '@/lib/coalesced-fetch'
import { buildCandles, RANGE_BUCKET_SEC } from '@/lib/candles'
import {
  ageLabel,
  changeParts,
  fmtPrice,
  fmtUsd,
  shortAddr,
  tileGradient,
  walletHue,
} from '@/lib/ui-format'

type Tab = 'Activity' | 'holders' | 'traders'
type Range = '5M' | '15M' | '1H' | '1D' | '1W'
type VolRange = '1H' | '6H' | '24H'

export default function TokenPage() {
  const params = useParams()
  const token = ((params?.address as string) ?? '') as Address

  const [pool, setPool] = useState<PoolToken | null>(null)
  const [trades, setTrades] = useState<EvmTradesResult | null>(null)
  const [holders, setHolders] = useState<EvmHoldersResult | null>(null)
  const [traderMeta, setTraderMeta] = useState<Record<string, TraderMeta>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('Activity')
  const [range, setRange] = useState<Range>('5M')
  const [volRange, setVolRange] = useState<VolRange>('1H')
  const [copied, setCopied] = useState(false)

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
      const res = await fetch(`/api/arc/${token}/trades`, { cache: 'no-store' })
      if (res.ok) setTrades((await res.json()) as EvmTradesResult)
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
    void loadHolders()
  }, [load, loadTrades, loadHolders])

  useEffect(() => {
    load()
    void loadTrades()
    void loadHolders()
  }, [load, loadTrades, loadHolders])

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      load()
      void loadTrades()
    }, 8_000)
    return () => clearInterval(id)
  }, [load, loadTrades])

  // Opt-in chart PFPs: only wallets with ArcFun profile + avatarUrl
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

  const chartMarkers: ChartTradeMarker[] = useMemo(() => {
    const out: ChartTradeMarker[] = []
    for (const t of trades?.trades ?? []) {
      const meta = traderMeta[t.trader.toLowerCase()]
      if (!meta?.avatarUrl) continue
      if (!(t.priceUsd > 0) || !(t.ts > 0)) continue
      out.push({
        time: t.ts,
        price: t.priceUsd,
        isBuy: t.isBuy,
        avatarUrl: meta.avatarUrl,
        trader: meta.addressChecksum || t.trader,
        displayName: meta.displayName,
        twitter: meta.twitter,
        valueUsd: t.valueUsd,
      })
    }
    return out
  }, [trades, traderMeta])

  const volWindowSec = useMemo(() => {
    if (volRange === '1H') return 3600
    if (volRange === '6H') return 6 * 3600
    return 86_400
  }, [volRange])

  const { vol, buys, sells, buyUsd, sellUsd } = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - volWindowSec
    let vol = 0
    let buys = 0
    let sells = 0
    let buyUsd = 0
    let sellUsd = 0
    for (const t of trades?.trades ?? []) {
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
  }, [trades, volWindowSec])

  const buyPct = vol > 0 ? (buyUsd / vol) * 100 : 50
  const sellPct = 100 - buyPct

  const explorer = ARC_EXPLORER || 'https://arcscan.app'
  const seed = token || pool?.symbol || 'arc'
  const { tile, mono } = tileGradient(seed)
  const chg = changeParts(pool?.priceChange24h)
  const candles = useMemo(
    () => buildCandles(trades?.trades ?? [], RANGE_BUCKET_SEC[range], pool?.currentPrice ?? 0),
    [trades, range, pool?.currentPrice],
  )

  const holderCount = holders?.holders?.length ?? 0
  const actTabs: { id: Tab; label: string }[] = [
    { id: 'Activity', label: 'Activity' },
    { id: 'holders', label: holderCount ? `${holderCount} holders` : 'Holders' },
    { id: 'traders', label: 'Top traders' },
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
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[9px] bg-lime-soft border border-lime-line text-xs font-semibold text-lime-t whitespace-nowrap">
                    Uni V3
                  </span>
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
                  label: 'Price',
                  value: fmtPrice(pool.currentPrice),
                  sub: 'per token',
                  subColor: 'var(--t3)',
                },
                {
                  label: '24H volume',
                  value: fmtUsd(vol),
                  sub: `${buyPct.toFixed(1)}% buys`,
                  subColor: 'var(--limeT)',
                },
                {
                  label: 'Liquidity',
                  value: '—',
                  sub: 'locked 12mo',
                  subColor: 'var(--t3)',
                },
                {
                  label: 'Holders',
                  value: holderCount ? String(holderCount) : '—',
                  sub: 'on Arc',
                  subColor: 'var(--limeT)',
                },
              ].map((m) => (
                <div key={m.label} className="px-5 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0">
                  <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 whitespace-nowrap">
                    {m.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums tracking-[-0.028em] leading-tight truncate">
                    {m.value}
                  </span>
                  <span className="text-xs font-semibold tabular-nums" style={{ color: m.subColor }}>
                    {m.sub}
                  </span>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="border border-hair rounded-[28px] bg-s1 px-6 pt-[22px] pb-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex gap-4 text-xs font-semibold tabular-nums text-t3">
                  <span>
                    M <span className="text-lime-t">{fmtUsd(pool.marketCap)}</span>
                  </span>
                  <span>
                    Δ{' '}
                    <span style={{ color: chg.stroke }}>{chg.label}</span>
                  </span>
                  <span>
                    P <span className="text-lime-t">{fmtPrice(pool.currentPrice)}</span>
                  </span>
                  <span>
                    V <span className="text-t2">{fmtUsd(vol)}</span>
                  </span>
                </div>
                <div className="flex gap-1 p-1 bg-s2 border border-hair rounded-xl">
                  {(['5M', '15M', '1H', '1D', '1W'] as Range[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      className="px-3.5 py-1.5 rounded-[9px] text-xs font-semibold transition-colors"
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

              <div className="relative mt-[18px] rounded-2xl overflow-visible">
                <TokenChart candles={candles} height={280} markers={chartMarkers} />
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
                    <p className="text-sm text-t3 text-center py-10">No trades yet.</p>
                  ) : (
                    trades!.trades.slice(0, 40).map((t, i) => {
                      const tm = traderMeta[t.trader.toLowerCase()]
                      return (
                      <a
                        key={`${t.txHash}-${i}`}
                        href={`${explorer}/tx/${t.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="grid grid-cols-[1.4fr_.7fr_1fr_1fr_.8fr] gap-3 px-3 py-3.5 border-b border-hair2 text-sm items-center tabular-nums hover:bg-white/[0.02]"
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
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
                        </span>
                        <span
                          className="font-semibold"
                          style={{ color: t.isBuy ? 'var(--limeT)' : 'var(--coral)' }}
                        >
                          {t.isBuy ? 'Buy' : 'Sell'}
                        </span>
                        <span className="font-medium">{fmtUsd(t.valueUsd)}</span>
                        <span className="text-t2 truncate">
                          {t.tokenAmount != null ? String(t.tokenAmount) : '—'}
                        </span>
                        <span className="text-right text-t3 text-[13px]">{ageLabel(t.ts)} ago</span>
                      </a>
                    )})
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

              {tab === 'traders' && (
                <div className="px-6 py-10 text-sm text-t3 text-center">
                  Top-trader leaderboard needs a volume index — coming next.
                  <p className="mt-3 text-xs">
                    Factory {ARC.INSTANT_FACTORY.slice(0, 10)}… ·{' '}
                    {pool.instantMeta?.uniPool
                      ? `pool ${pool.instantMeta.uniPool.slice(0, 10)}…`
                      : 'Uni V3'}
                  </p>
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
