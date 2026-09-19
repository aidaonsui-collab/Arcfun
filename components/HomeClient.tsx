'use client'

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2, Search, SlidersHorizontal } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import { isReflectionToken, volumeForWindow } from '@/lib/tokens'
import { TokenCard } from '@/components/TokenCard'
import { coalescedFetch } from '@/lib/coalesced-fetch'
import { ageLabel, fmtUsd } from '@/lib/ui-format'
import { quoteAsset, quoteKind, type QuoteKind } from '@/lib/quote-assets'
import { EVE_TOKEN } from '@/lib/eve'
import { cdnImage } from '@/lib/cdn-image'

type SortKey = 'Top volume' | 'New' | 'Top MC'
type PairFilter = 'all' | QuoteKind | 'reflect'

const PAIR_CHIPS: { id: PairFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'usdc', label: 'USDC' },
  { id: 'mmf', label: 'MMF' },
  { id: 'equity', label: 'Equity' },
  { id: 'btc', label: 'BTC' },
  { id: 'gold', label: 'Gold' },
  { id: 'reflect', label: 'Reflect' },
]

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
  const [pair, setPair] = useState<PairFilter>('all')

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
    if (pair === 'reflect') list = list.filter((t) => isReflectionToken(t))
    else if (pair !== 'all') list = list.filter((t) => quoteKind(t.instantMeta?.quote) === pair)
    if (sort === 'New') {
      list.sort((a, b) => {
        // Missing createdAt is a just-stamped launch, not an old one. Sorting
        // those to 0 put them under every aged token on Recent.
        const ta = a.createdAt && a.createdAt > 0 ? a.createdAt : Number.POSITIVE_INFINITY
        const tb = b.createdAt && b.createdAt > 0 ? b.createdAt : Number.POSITIVE_INFINITY
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
  }, [tokens, filter, sort, pair])

  const padVolume = useMemo(() => {
    let volume24h = 0
    let volumeAll = 0
    for (const t of tokens) {
      volume24h += t.volume24h ?? 0
      volumeAll += t.volumeAll ?? 0
    }
    return { volume24h, volumeAll }
  }, [tokens])

  const featured = useMemo(() => {
    const eve = tokens.find((t) => (t.coinType || '').toLowerCase() === EVE_TOKEN.toLowerCase())
    if (eve) return eve
    return [...tokens].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))[0] ?? null
  }, [tokens])

  return (
    <main className="relative min-h-screen text-white pt-16 pb-16">
      <Suspense fallback={null}>
        <QuerySync onChange={setFilter} />
      </Suspense>
      <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6">
        <section className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-end sm:justify-between md:pt-8">
          <div className="max-w-xl">
            <p className="text-xs font-medium uppercase tracking-widest text-lime-t">Instant on Arc</p>
            <h1 className="mt-2 m-0 text-3xl font-semibold tracking-tight">
              Launch on Arc.
              <br />
              Pair it to money.
            </h1>
            <p className="mt-3 mb-0 max-w-md text-sm text-t2">
              Full float onto Uniswap from block one. Quoted in USDC and tokenized funds, not a bonding curve.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:min-w-64">
            <HomeStat label="24h volume" value={fmtUsd(padVolume.volume24h)} />
            <HomeStat label="All-time" value={fmtUsd(padVolume.volumeAll)} />
          </div>
        </section>

        {featured ? <FeaturedLaunch token={featured} /> : null}

        <section id="all-launches" className="mt-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-t3" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type token name or ticker"
                aria-label="Search tokens"
                className="h-11 w-full rounded-full bg-s1 pl-10 pr-4 text-sm outline-none shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)] placeholder:text-white/30 focus:shadow-[0_0_0_1px_rgb(110_200_232_/_0.45)]"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-t3 sm:inline">Sort</span>
              <div className="flex rounded-full bg-s1 p-1 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
                {SORT_TABS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSort(key)}
                    className={`h-8 rounded-full px-3 text-xs font-medium transition-colors ${
                      sort === key ? 'bg-lime text-accent-fg' : 'text-t2 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1">
            <SlidersHorizontal className="size-3.5 shrink-0 text-t3" />
            <span className="shrink-0 text-xs text-t3">Paired with</span>
            {PAIR_CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setPair(c.id)}
                className={`h-8 shrink-0 rounded-full px-3 text-xs font-medium shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)] ${
                  pair === c.id ? 'bg-lime text-accent-fg' : 'bg-s1 text-t2 hover:text-white'
                }`}
              >
                {c.label}
              </button>
            ))}
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
                  className="inline-flex h-11 items-center rounded-full bg-lime px-6 text-sm font-semibold text-accent-fg hover:bg-lime-2"
                >
                  Launch a token
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t, i) => (
                <TokenCard key={t.coinType || t.poolId || t.id || i} token={t} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

function FeaturedLaunch({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId
  const quote = quoteAsset(token.instantMeta?.quote)
  const up = (token.priceChange24h ?? 0) >= 0
  const pct = token.priceChange24h ?? 0
  const img = token.imageUrl || token.logoUrl
  const vol = volumeForWindow(token, '24H')
  const hrefOk = /^0x[a-fA-F0-9]{40}$/.test(address)

  const body = (
    <div className="token-tile relative overflow-hidden rounded-2xl p-5 sm:p-6">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 pair-watermark" aria-hidden>
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 80% 70% at 80% 50%, rgb(${quote.tint} / 0.22), transparent 72%)`,
          }}
        />
        {quote.mark ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={quote.mark}
            alt=""
            className="absolute right-6 top-1/2 size-36 -translate-y-1/2 rounded-full object-cover opacity-80"
          />
        ) : img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cdnImage(img, 320)} alt="" className="absolute inset-0 size-full object-cover opacity-20" />
        ) : null}
      </div>

      <p className="relative m-0 text-xs font-medium uppercase tracking-widest text-lime-t">Featured on Arc</p>
      <div className="relative mt-4 flex items-start gap-4">
        <span className="size-14 shrink-0 overflow-hidden rounded-full shadow-[0_0_0_1px_rgb(255_255_255_/_0.12)]">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cdnImage(img, 112)} alt="" className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center text-lg font-semibold">{(token.symbol || '?')[0]}</span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 truncate text-2xl font-semibold tracking-tight">${token.symbol}</h2>
            <span className="truncate text-t2">{token.name}</span>
            {address.toLowerCase() === EVE_TOKEN.toLowerCase() ? (
              <span className="rounded-full bg-lime/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-lime-t">
                Platform
              </span>
            ) : isReflectionToken(token) ? (
              <span className="rounded-full bg-fun/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fun">
                Reflect
              </span>
            ) : (
              <span className="rounded-full bg-s2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-t2">
                Meme
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="text-3xl font-semibold tracking-tight tabular-nums">{fmtUsd(token.marketCap)}</div>
            <div className={`mb-1 text-sm tabular-nums ${up ? 'text-up' : 'text-down'}`}>
              {`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`} 24h
            </div>
          </div>
          <div className="relative mt-3 flex flex-wrap items-center gap-2 text-sm text-t2">
            <span>Paired with</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-s2 py-0.5 pl-1 pr-2 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
              {quote.mark ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={quote.mark} alt="" className="size-3.5 rounded-full object-cover" />
              ) : null}
              <span className="text-white">{quote.symbol}</span>
            </span>
            <span className="text-t3">·</span>
            <span>
              Vol 24h <span className="tabular-nums text-white">{fmtUsd(vol)}</span>
            </span>
            <span className="text-t3">·</span>
            <span className="text-t3">{ageLabel(token.createdAt)} ago</span>
          </div>
        </div>
      </div>
    </div>
  )

  if (!hrefOk) return <div className="mt-8">{body}</div>
  return (
    <Link href={`/token/${address}`} className="mt-8 block">
      {body}
    </Link>
  )
}

function HomeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-s1 px-4 py-3 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
      <div className="text-[11px] uppercase tracking-wide text-t3">{label}</div>
      <div className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</div>
    </div>
  )
}
