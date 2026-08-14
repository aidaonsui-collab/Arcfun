'use client'

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import type { PoolToken, VolumeWindow } from '@/lib/tokens'
import { volumeForWindow } from '@/lib/tokens'
import { TokenCard, TokenRailCard } from '@/components/TokenCard'
import { coalescedFetch } from '@/lib/coalesced-fetch'
import { changeParts, fmtUsd, tileGradient } from '@/lib/ui-format'

type SortKey = 'Top volume' | 'New' | 'Top MC'

const VOL_WINDOWS: VolumeWindow[] = ['1H', '6H', '12H', '24H']

function HomeInner() {
  const searchParams = useSearchParams()
  const q = (searchParams.get('q') || '').trim().toLowerCase()

  const [tokens, setTokens] = useState<PoolToken[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('Top MC')
  const [volWindow, setVolWindow] = useState<VolumeWindow>('24H')
  const [filter, setFilter] = useState(q)

  useEffect(() => {
    setFilter(q)
  }, [q])

  const load = useCallback(async () => {
    try {
      const res = await coalescedFetch('/api/arc/tokens')
      if (res.ok) {
        const data = (await res.json()) as { tokens?: PoolToken[] }
        setTokens(data.tokens ?? [])
      }
    } catch {
      /* keep prior */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 15_000)
    return () => clearInterval(id)
  }, [load])

  const filtered = useMemo(() => {
    let list = [...tokens]
    if (filter) {
      list = list.filter((t) => {
        const hay = `${t.name} ${t.symbol} ${t.coinType} ${t.poolId} ${t.creator}`.toLowerCase()
        return hay.includes(filter)
      })
    }
    if (sort === 'New') {
      list.sort(
        (a, b) =>
          (b.createdAt ?? b.lastTradeAt ?? 0) - (a.createdAt ?? a.lastTradeAt ?? 0),
      )
    } else if (sort === 'Top MC') {
      list.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    } else {
      // Top volume — selected window; fall back to last activity when volumes are empty.
      list.sort((a, b) => {
        const va = volumeForWindow(a, volWindow)
        const vb = volumeForWindow(b, volWindow)
        if (va !== vb) return vb - va
        const ta = a.lastTradeAt ?? a.createdAt ?? 0
        const tb = b.lastTradeAt ?? b.createdAt ?? 0
        if (ta !== tb) return tb - ta
        return (b.marketCap ?? 0) - (a.marketCap ?? 0)
      })
    }
    return list
  }, [tokens, filter, sort, volWindow])

  const rail = useMemo(() => {
    return [...tokens]
      .sort(
        (a, b) =>
          (b.createdAt ?? b.lastTradeAt ?? 0) - (a.createdAt ?? a.lastTradeAt ?? 0),
      )
      .slice(0, 8)
  }, [tokens])

  const stack = useMemo(
    () => [...tokens].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 3),
    [tokens],
  )
  const liveCount = tokens.length
  const sortTabs: SortKey[] = ['Top volume', 'New', 'Top MC']

  return (
    <main className="relative min-h-screen text-white pt-16 pb-16 overflow-hidden">
      <div aria-hidden="true" className="hero-grid-fade" />
      <div className="relative z-10 max-w-desk mx-auto px-4 sm:px-10">
        <section className="relative mt-6">
          <div className="relative max-w-[600px] flex flex-col gap-3">
            <span className="self-start inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-lime-soft border border-lime-line text-xs font-semibold text-lime-t tracking-tightish whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot" />
              {liveCount} live pool{liveCount === 1 ? '' : 's'} · Instant on Arc
            </span>
            <h1 className="m-0 text-[26px] sm:text-[32px] leading-[1.15] font-bold tracking-display text-pretty text-white">
              The best way to launch and trade tokens on Arc.
            </h1>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link
                href="/create"
                className="inline-flex h-[42px] items-center px-6 rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
              >
                Launch a token
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-[42px] items-center px-5 rounded-full bg-white/10 border border-hair text-white text-sm font-medium tracking-tightish hover:bg-white/[0.14] transition-colors"
              >
                How it works
              </Link>
            </div>
          </div>

          {stack.length > 0 && (
            <div className="hidden lg:block absolute right-14 top-[52px] w-72 h-[260px]">
              {stack.map((t, i) => {
                const address = t.coinType || t.poolId
                const seed = address || t.symbol
                const { tile } = tileGradient(seed)
                const chg = changeParts(t.priceChange24h)
                const initial = (t.symbol || t.name || '?').charAt(0).toUpperCase()
                const img = t.imageUrl || t.logoUrl
                const transform = `translateY(${i * 62}px) rotate(${i * 1.6 - 1.6}deg) scale(${1 - i * 0.045})`
                const shade = `rgba(0,0,0,${img ? 0.42 + i * 0.1 : 0.18 + i * 0.14})`
                return (
                  <Link
                    key={t.id || seed}
                    href={`/token/${address}`}
                    className="absolute left-0 right-0 top-0 h-[118px] rounded-[22px] overflow-hidden border border-white/10 shadow-[0_22px_48px_rgba(0,0,0,0.55)] cursor-pointer hover:brightness-110 transition-[filter]"
                    style={{ background: tile, transform, zIndex: 30 - i * 10 }}
                  >
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={img}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : null}
                    <div className="absolute inset-0" style={{ background: shade }} />
                    <div className="relative h-full px-4 py-3.5 flex flex-col justify-between">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-lg bg-black/35 overflow-hidden flex items-center justify-center text-xs font-bold text-white">
                            {img ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={img} alt="" className="h-full w-full object-cover" />
                            ) : (
                              initial
                            )}
                          </span>
                          <span className="text-[13px] font-semibold text-white tracking-tightish">
                            {t.name}
                          </span>
                        </span>
                        <span
                          className="px-2 py-0.5 rounded-lg text-[11px] font-bold tabular-nums"
                          style={{ background: chg.chipBg, color: chg.chipFg }}
                        >
                          {chg.label}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[22px] font-semibold tracking-[-0.03em] tabular-nums text-white">
                          {fmtUsd(t.marketCap)}
                        </span>
                        <span className="text-[11px] font-semibold text-white/70">{t.symbol}</span>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {rail.length > 0 && (
          <section className="mt-11">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <h2 className="m-0 text-[21px] font-semibold tracking-tightish">Top Memes</h2>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-lime-t">
                  <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot" />
                  live
                </span>
              </div>
            </div>
            <div className="rail-scroll flex gap-3 pb-1">
              {rail.map((t) => (
                <TokenRailCard key={t.id || t.coinType || t.poolId} token={t} />
              ))}
            </div>
          </section>
        )}

        <section id="all-launches" className="mt-11">
          <div className="flex items-center justify-between gap-5 flex-wrap">
            <h2 className="m-0 text-[21px] font-semibold tracking-tightish">All launches</h2>
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="flex gap-1 p-1 bg-s1 border border-hair rounded-[14px]">
                {sortTabs.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSort(s)}
                    className="px-[15px] py-[7px] rounded-[10px] text-[13px] font-medium tracking-tightish transition-colors"
                    style={{
                      background: sort === s ? 'var(--lime)' : 'transparent',
                      color: sort === s ? '#fff' : 'rgba(255,255,255,0.52)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {sort === 'Top volume' && (
                <div className="flex items-center gap-1 p-1 bg-s1 border border-hair rounded-[14px]">
                  {VOL_WINDOWS.map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setVolWindow(w)}
                      className="min-w-[40px] px-2.5 py-[7px] rounded-[10px] text-[13px] font-medium tabular-nums tracking-tightish transition-colors"
                      style={{
                        background: volWindow === w ? 'rgba(255,255,255,0.12)' : 'transparent',
                        color: volWindow === w ? '#fff' : 'rgba(255,255,255,0.52)',
                      }}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              )}
              <div className="h-[38px] flex items-center gap-2 px-3 bg-s1 border border-hair rounded-[14px]">
                <span className="w-[13px] h-[13px] border-[1.6px] border-t3 rounded-full" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter"
                  className="w-[110px] bg-transparent border-0 outline-none text-[13px] placeholder:text-white/25"
                />
              </div>
            </div>
          </div>

          {loading && filtered.length === 0 ? (
            <div className="mt-10 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-lime-t" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="mt-[18px] rounded-[24px] border border-hair bg-s2 p-12 text-center text-t2 text-sm shadow-[0_12px_40px_rgba(10,20,40,0.35)]">
              Nothing launched yet — be the first.
              <div className="mt-4">
                <Link
                  href="/create"
                  className="inline-flex h-11 items-center px-6 rounded-2xl bg-lime text-white text-sm font-semibold shadow-[0_8px_24px_rgba(47,132,219,0.3)]"
                >
                  Launch a token
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-[18px] grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {filtered.map((t, i) => (
                <TokenCard key={t.id || t.coinType || t.poolId} token={t} rank={i} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-lime-t" />
        </main>
      }
    >
      <HomeInner />
    </Suspense>
  )
}
