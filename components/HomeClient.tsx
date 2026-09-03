'use client'

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react'
import { useFlipGrid } from '@/components/useFlipGrid'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import type { PoolToken, VolumeWindow } from '@/lib/tokens'
import { volumeForWindow } from '@/lib/tokens'
import { TokenCard, TokenRailCard } from '@/components/TokenCard'
import { PadVolumeTile } from '@/components/PadVolumeTile'
import { coalescedFetch } from '@/lib/coalesced-fetch'

type SortKey = 'Top volume' | 'New' | 'Top MC'

function tokenKey(t: PoolToken) {
  return (t.id || t.coinType || t.poolId || '').toLowerCase()
}


const VOL_WINDOWS: VolumeWindow[] = ['1H', '6H', '12H', '24H']

/**
 * Reads `?q=` and renders nothing.
 *
 * useSearchParams forces a client-side-rendering bailout for whatever Suspense boundary
 * contains it. Keeping it in a leaf that outputs no markup means only this empty node
 * bails — the token grid above stays in the prerendered HTML, so the route is still
 * statically cacheable and still ships content on first byte.
 */
function QuerySync({ onChange }: { onChange: (v: string) => void }) {
  const sp = useSearchParams()
  const q = (sp.get('q') ?? '').trim().toLowerCase()
  useEffect(() => {
    onChange(q)
  }, [q, onChange])
  return null
}

export function HomeClient({
  initialTokens,
  initialQ,
}: {
  initialTokens: PoolToken[]
  /** Only for callers that already know the query; normally read from the URL below. */
  initialQ?: string
}) {
  const q = (initialQ ?? '').trim().toLowerCase()

  const [tokens, setTokens] = useState<PoolToken[]>(initialTokens)
  const [loading, setLoading] = useState(initialTokens.length === 0)
  const [sort, setSort] = useState<SortKey>('Top MC')
  const [volWindow, setVolWindow] = useState<VolumeWindow>('24H')
  // Seed from initialQ if a caller passed one. URL `?q=` is applied by QuerySync.
  // Do not sync `q` in an effect — it is '' when HomePage omits initialQ and would
  // wipe QuerySync on mount.
  const [filter, setFilter] = useState(q)

  useEffect(() => {
    setTokens(initialTokens)
    if (initialTokens.length > 0) setLoading(false)
  }, [initialTokens])

  const load = useCallback(async () => {
    try {
      const res = await coalescedFetch(`/api/arc/tokens?t=${Date.now()}`)
      if (res.ok) {
        const data = (await res.json()) as { tokens?: PoolToken[] }
        const next = data.tokens ?? []
        setTokens((prev) => (next.length === 0 && prev.length > 0 ? prev : next))
      }
    } catch {
      /* keep prior */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 20_000)
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
      list.sort((a, b) => {
        const ta = a.createdAt ?? 0
        const tb = b.createdAt ?? 0
        if (tb !== ta) return tb - ta
        return (a.symbol || a.name || '').localeCompare(b.symbol || b.name || '')
      })
    } else if (sort === 'Top MC') {
      list.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    } else {
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

  const flipIds = useMemo(() => filtered.map(tokenKey), [filtered])
  const gridRef = useFlipGrid(flipIds)

  const rail = useMemo(() => {
    return [...tokens].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 3)
  }, [tokens])

  const padVolume = useMemo(() => {
    let volume24h = 0
    let volumeAll = 0
    for (const t of tokens) {
      volume24h += t.volume24h ?? 0
      volumeAll += t.volumeAll ?? 0
    }
    return { volume24h, volumeAll }
  }, [tokens])

  const sortTabs: SortKey[] = ['Top volume', 'New', 'Top MC']

  return (
    <main className="relative min-h-screen text-white pt-16 pb-16 overflow-hidden">
      <Suspense fallback={null}>
        <QuerySync onChange={setFilter} />
      </Suspense>
      <div aria-hidden="true" className="hero-grid-fade" />
      <div className="relative z-10 max-w-desk mx-auto px-4 sm:px-10">
        <section className="relative mt-6 lg:min-h-[200px]">
          <div className="relative max-w-[600px] flex flex-col gap-3">
            <h1 className="m-0 text-[26px] sm:text-[32px] leading-[1.15] font-bold tracking-display text-pretty text-white">
              The best way to launch and trade tokens on Arc.
            </h1>
            <div className="flex flex-wrap items-stretch gap-2.5 pt-1">
              <PadVolumeTile
                volume24h={padVolume.volume24h}
                volumeAll={padVolume.volumeAll}
              />
            </div>
            <div className="flex flex-wrap gap-3 pt-1 lg:hidden">
              <Link
                href="/create"
                className="inline-flex h-[42px] items-center px-6 rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
              >
                Launch a token
              </Link>
            </div>
          </div>

          <div className="hidden lg:flex absolute right-0 top-0 w-72 h-[200px] items-center justify-center">
            <Link
              href="/create"
              className="inline-flex h-14 items-center px-8 rounded-full bg-lime text-white text-[16px] font-semibold tracking-tightish hover:bg-lime-2 transition-colors shadow-[0_12px_36px_rgba(47,132,219,0.35)]"
            >
              Launch a token
            </Link>
          </div>
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
            <div
              ref={gridRef}
              className="mt-[18px] grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3"
            >
              {filtered.map((t, i) => {
                const id = tokenKey(t)
                return (
                  <div key={id || i} data-flip-id={id || String(i)} className="min-w-0">
                    <TokenCard token={t} rank={i} />
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
