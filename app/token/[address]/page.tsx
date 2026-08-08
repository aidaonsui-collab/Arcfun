'use client'

/**
 * Token detail — stats, buy/sell (ArcDexTradePanel), recent trades, top holders.
 * No TradingView/chart integration and no "open full RobinSwap" cross-link — this fork's
 * create+trade surface stays on this one page. See README for scope notes.
 */
import { useParams } from 'next/navigation'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { type Address } from 'viem'
import Link from 'next/link'
import { Loader2, ExternalLink, Users, List } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import type { EvmTradesResult } from '@/lib/evm-trades'
import type { EvmHoldersResult } from '@/lib/evm-holders'
import { ArcDexTradePanel } from '@/components/ArcDexTradePanel'
import { ARC_EXPLORER, ARC } from '@/lib/contracts-arc'
import { coalescedFetch } from '@/lib/coalesced-fetch'

type Tab = 'trades' | 'holders' | 'info'

function fmtUsd(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function ageLabel(ts: number): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function TokenPage() {
  const params = useParams()
  const token = ((params?.address as string) ?? '') as Address

  const [pool, setPool] = useState<PoolToken | null>(null)
  const [trades, setTrades] = useState<EvmTradesResult | null>(null)
  const [holders, setHolders] = useState<EvmHoldersResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('trades')

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

  const oneDayAgoSec = useMemo(() => Math.floor(Date.now() / 1000) - 86_400, [])
  const { vol24h, txns24h } = useMemo(() => {
    let vol = 0
    let count = 0
    for (const t of trades?.trades ?? []) {
      if (t.ts < oneDayAgoSec) continue
      vol += t.valueUsd
      count++
    }
    return { vol24h: vol, txns24h: count }
  }, [trades, oneDayAgoSec])

  const explorer = ARC_EXPLORER || 'https://arcscan.app'

  if (loading && !pool) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
      </main>
    )
  }

  if (!pool) {
    return (
      <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-gray-400">Token not found on Arc.</p>
        <Link href="/create" className="text-sky-400 hover:text-sky-300 text-sm">
          Launch on Arc
        </Link>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white px-4 pt-24 pb-16">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl overflow-hidden bg-white/5 shrink-0 flex items-center justify-center text-lg font-bold text-gray-500">
            {pool.imageUrl || pool.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pool.imageUrl || pool.logoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              (pool.symbol || '?').slice(0, 2)
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{pool.name}</h1>
            <p className="text-sm text-gray-500">
              ${pool.symbol} ·{' '}
              <a
                href={`${explorer}/token/${token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-300 inline-flex items-center gap-1"
              >
                {token.slice(0, 6)}…{token.slice(-4)} <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3 text-sm text-sky-100/90">
          Instant DEX ⚡ — full supply on Uniswap V3 (USDC pair, 1%) from block one · LP locked 1 year
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Market cap" value={fmtUsd(pool.marketCap)} />
          <Stat label="24h volume" value={fmtUsd(vol24h)} />
          <Stat label="24h txns" value={String(txns24h)} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="flex gap-1 p-1 rounded-xl bg-white/5 w-fit">
              {(
                [
                  ['trades', 'Trades', <List key="i" className="w-3.5 h-3.5" />],
                  ['holders', 'Holders', <Users key="i" className="w-3.5 h-3.5" />],
                  ['info', 'Info', null],
                ] as const
              ).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                    tab === id ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>

            {tab === 'trades' && (
              <div className="rounded-2xl border border-white/10 divide-y divide-white/5 overflow-hidden">
                {!trades?.trades.length ? (
                  <p className="text-sm text-gray-600 text-center py-8">No trades yet.</p>
                ) : (
                  trades.trades.slice(0, 40).map((t, i) => (
                    <a
                      key={`${t.txHash}-${i}`}
                      href={`${explorer}/tx/${t.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-4 py-2.5 text-xs hover:bg-white/[0.03]"
                    >
                      <span className={t.isBuy ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                        {t.isBuy ? 'Buy' : 'Sell'}
                      </span>
                      <span className="font-mono text-gray-400">
                        {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                      </span>
                      <span className="font-mono text-gray-300">{fmtUsd(t.valueUsd)}</span>
                      <span className="text-gray-600">{ageLabel(t.ts)}</span>
                    </a>
                  ))
                )}
              </div>
            )}

            {tab === 'holders' && (
              <div className="rounded-2xl border border-white/10 divide-y divide-white/5 overflow-hidden">
                {!holders?.holders.length ? (
                  <p className="text-sm text-gray-600 text-center py-8">No holders indexed yet.</p>
                ) : (
                  holders.holders.map((h) => (
                    <a
                      key={h.address}
                      href={`${explorer}/address/${h.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-4 py-2.5 text-xs hover:bg-white/[0.03]"
                    >
                      <span className="text-gray-600">#{h.rank}</span>
                      <span className="font-mono text-gray-300">
                        {h.address.slice(0, 6)}…{h.address.slice(-4)}
                        {h.isDev ? <span className="ml-1.5 text-amber-400">dev</span> : null}
                      </span>
                      <span className="font-mono text-gray-400">{h.balance}</span>
                      <span className="text-gray-600">{h.percentage}%</span>
                    </a>
                  ))
                )}
              </div>
            )}

            {tab === 'info' && (
              <div className="space-y-3 text-sm">
                {pool.description && <p className="text-gray-400 leading-relaxed">{pool.description}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Chain" value="Arc · 5042" />
                  <Stat label="DEX" value="Uniswap V3" />
                  <Stat label="Pair" value="USDC · 1%" />
                  <Stat label="LP lock" value="1 year" />
                  {pool.creator && (
                    <Stat label="Creator" value={`${pool.creator.slice(0, 6)}…${pool.creator.slice(-4)}`} />
                  )}
                </div>
                {pool.instantMeta?.uniPool && (
                  <a
                    href={`${explorer}/address/${pool.instantMeta.uniPool}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300"
                  >
                    Uni pool: {pool.instantMeta.uniPool.slice(0, 10)}… <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <p className="text-[10px] text-gray-600">Factory {ARC.INSTANT_FACTORY.slice(0, 10)}…</p>
              </div>
            )}
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-24">
              <ArcDexTradePanel token={token} symbol={pool.symbol} onTraded={refreshAfterTrade} />
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5 border bg-[var(--cp-card)] border-[var(--cp-line)]">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-sm font-semibold text-white mt-0.5 truncate">{value}</div>
    </div>
  )
}
