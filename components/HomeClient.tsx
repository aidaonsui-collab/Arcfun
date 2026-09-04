'use client'

import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2, Search, SlidersHorizontal } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import { isReflectionToken, volumeForWindow } from '@/lib/tokens'
import { TokenCard } from '@/components/TokenCard'
import { HeroBanners } from '@/components/HeroBanners'
import { coalescedFetch } from '@/lib/coalesced-fetch'

type SortKey = 'Top volume' | 'New' | 'Top MC'
type KindFilter = 'all' | 'meme' | 'reflect'

const SORT_TABS: { key: SortKey; label: string }[] = [
  { key: 'Top volume', label: '24 Volume' },
  { key: 'New', label: 'Recent' },
  { key: 'Top MC', label: 'Market cap' },
]

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
  const [sort, setSort] = useState<SortKey>('Top volume')
  // Seed from initialQ if a caller passed one. URL `?q=` is applied by QuerySync.
  // Do not sync `q` in an effect — it is '' when HomePage omits initialQ and would
  // wipe QuerySync on mount.
  const [filter, setFilter] = useState(q)
  const [kind, setKind] = useState<KindFilter>('all')
  const [kindOpen, setKindOpen] = useState(false)
  const kindWrap = useRef<HTMLDivElement>(null)

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
    if (kind === 'reflect') list = list.filter((t) => isReflectionToken(t))
    if (kind === 'meme') list = list.filter((t) => !isReflectionToken(t))
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
        const va = volumeForWindow(a, '24H')
        const vb = volumeForWindow(b, '24H')
        if (va !== vb) return vb - va
        const ta = a.lastTradeAt ?? a.createdAt ?? 0
        const tb = b.lastTradeAt ?? b.createdAt ?? 0
        if (ta !== tb) return tb - ta
        return (b.marketCap ?? 0) - (a.marketCap ?? 0)
      })
    }
    return list
  }, [tokens, filter, sort, kind])

  useEffect(() => {
    if (!kindOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!kindWrap.current?.contains(e.target as Node)) setKindOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [kindOpen])

  return (
    <main className="relative min-h-screen text-white pt-16 pb-16">
      <Suspense fallback={null}>
        <QuerySync onChange={setFilter} />
      </Suspense>
      <div className="relative z-10 max-w-[1120px] mx-auto px-4 sm:px-6">
        <section className="pt-6 md:pt-8">
          <HeroBanners />
        </section>

        <section id="all-launches" className="mt-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-t3" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type token name or ticker"
                aria-label="Search tokens"
                className="w-full h-11 pl-11 pr-4 rounded-full bg-s1 border border-hair text-sm tracking-tightish outline-none placeholder:text-white/30 focus:border-lime-line"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-t3 sm:inline">Sort</span>
              <div className="flex rounded-full bg-s1 p-1 border border-hair">
                {SORT_TABS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSort(key)}
                    className="h-8 rounded-full px-3 text-xs font-medium transition-colors duration-150"
                    style={{
                      background: sort === key ? 'var(--lime)' : 'transparent',
                      color: sort === key ? '#fff' : 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="relative" ref={kindWrap}>
                <button
                  type="button"
                  onClick={() => setKindOpen((o) => !o)}
                  className="inline-flex h-9 items-center gap-1.5 px-3 rounded-full bg-s1 border border-hair text-xs font-medium text-t2 hover:text-white hover:border-lime-line"
                >
                  <SlidersHorizontal className="size-3.5" />
                  Filter
                </button>
                {kindOpen && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[160px] rounded-2xl border border-hair bg-s1 p-1 shadow-[0_12px_40px_rgba(10,20,40,0.45)]">
                    {(
                      [
                        ['all', 'All launches'],
                        ['meme', 'Meme'],
                        ['reflect', 'Reflect'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setKind(key)
                          setKindOpen(false)
                        }}
                        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-left hover:bg-white/5"
                        style={{ color: kind === key ? '#fff' : 'rgba(255,255,255,0.7)' }}
                      >
                        {label}
                        {kind === key ? <span className="text-lime-t">·</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {loading && filtered.length === 0 ? (
            <div className="mt-10 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-lime-t" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="mt-16 text-center text-sm text-t2">
              No launches match that search.
              <div className="mt-4">
                <Link
                  href="/create"
                  className="inline-flex h-11 items-center px-6 rounded-full bg-lime text-white text-sm font-semibold hover:bg-lime-2"
                >
                  Launch a token
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t, i) => (
                <TokenCard key={i} token={t} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
