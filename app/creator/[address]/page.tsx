'use client'

/**
 * Public creator profile — coins launched, top coin, claimable rewards note.
 */
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { Loader2, ExternalLink, Copy, Check, Share2 } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import type { CreatorProfile } from '@/lib/arc-creator'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { ageLabel, fmtUsd, shortAddr, tileGradient } from '@/lib/ui-format'

export default function CreatorPage() {
  const params = useParams()
  const raw = ((params?.address as string) ?? '').trim()
  const { address: connected } = useAccount()

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    if (!raw) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/arc/creator/${raw}`, { cache: 'no-store' })
      const data = (await res.json()) as { ok?: boolean; profile?: CreatorProfile; error?: string }
      if (!res.ok || !data.ok || !data.profile) {
        setError(data.error || 'Creator not found')
        setProfile(null)
        return
      }
      setProfile(data.profile)
    } catch (e) {
      setError((e as Error).message)
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [raw])

  useEffect(() => {
    void load()
  }, [load])

  const isSelf =
    !!connected &&
    !!profile &&
    connected.toLowerCase() === profile.address.toLowerCase()

  const filtered = useMemo(() => {
    const tokens = profile?.tokens ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return tokens
    return tokens.filter((t) => {
      const hay = `${t.name} ${t.symbol} ${t.coinType} ${t.poolId}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [profile, q])

  const copyAddr = useCallback(() => {
    if (!profile) return
    navigator.clipboard
      .writeText(profile.addressChecksum)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [profile])

  const share = useCallback(() => {
    if (!profile || typeof window === 'undefined') return
    const url = window.location.href
    if (navigator.share) {
      void navigator.share({ title: `Creator ${profile.short} on Arcfun`, url }).catch(() => {
        void navigator.clipboard.writeText(url)
      })
    } else {
      void navigator.clipboard.writeText(url)
    }
  }, [profile])

  const explorer = ARC_EXPLORER || 'https://arcscan.app'
  const seed = profile?.addressChecksum || raw || 'creator'
  const { tile, mono } = tileGradient(seed)

  if (loading && !profile) {
    return (
      <main className="min-h-screen text-white flex items-center justify-center pt-16">
        <Loader2 className="w-8 h-8 animate-spin text-lime-t" />
      </main>
    )
  }

  if (error || !profile) {
    return (
      <main className="min-h-screen text-white flex flex-col items-center justify-center gap-4 px-4 pt-16">
        <p className="text-t2">{error || 'Creator not found'}</p>
        <Link href="/" className="text-lime-t hover:text-white text-sm font-semibold">
          ← Home
        </Link>
      </main>
    )
  }

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        {/* Header card */}
        <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 mb-5">
          <div className="flex flex-col sm:flex-row sm:items-start gap-5">
            <span
              className="w-[72px] h-[72px] rounded-full shrink-0 flex items-center justify-center text-[28px] font-bold tracking-[-0.04em]"
              style={{ background: tile, color: mono }}
              aria-hidden
            >
              {profile.short.slice(2, 4).toUpperCase()}
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5 mb-2">
                <h1 className="m-0 text-[22px] sm:text-[26px] font-semibold tracking-tightish tabular-nums">
                  {profile.short}
                </h1>
                {isSelf && (
                  <span className="px-2 py-0.5 rounded-lg bg-lime-soft text-lime-t text-[11px] font-semibold">
                    You
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-t3">
                <button
                  type="button"
                  onClick={copyAddr}
                  className="inline-flex items-center gap-1 hover:text-t2 tabular-nums"
                  title={copied ? 'Copied!' : 'Copy address'}
                >
                  {profile.addressChecksum}
                  {copied ? <Check className="w-3.5 h-3.5 text-lime-t" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <a
                  href={`${explorer}/address/${profile.addressChecksum}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-lime-t"
                >
                  Explorer <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              <p className="m-0 mt-3 text-sm text-t2 max-w-xl">
                Tokens launched from this wallet on Arcfun (Instant, Reflection, and curve). Creator LP
                fee rewards accrue to the rewards wallet set at launch.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                type="button"
                onClick={share}
                className="inline-flex h-10 items-center gap-2 px-4 rounded-xl border border-hair bg-s2 text-sm font-semibold hover:border-lime-line transition-colors"
              >
                <Share2 className="w-4 h-4" /> Share
              </button>
              {isSelf && (
                <Link
                  href="/create"
                  className="inline-flex h-10 items-center px-4 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 transition-colors"
                >
                  + Create coin
                </Link>
              )}
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          <StatCard
            label="Coins created"
            value={String(profile.coinsCreated)}
            sub={profile.coinsCreated === 1 ? '1 launch' : `${profile.coinsCreated} launches`}
          />
          <StatCard
            label="Top coin"
            value={profile.topCoin?.symbol || '—'}
            sub={profile.topCoin ? fmtUsd(profile.topCoin.marketCap) + ' MC' : 'No launches yet'}
            href={profile.topCoin ? `/token/${profile.topCoin.address}` : undefined}
          />
          <StatCard
            label="Total MC"
            value={fmtUsd(profile.totalMarketCap)}
            sub={
              profile.latest
                ? `Latest · ${profile.latest.symbol}${profile.latest.createdAt ? ` · ${ageLabel(profile.latest.createdAt)}` : ''}`
                : 'Combined market caps'
            }
          />
        </section>

        {/* Rewards callout */}
        <section className="border border-hair rounded-[20px] bg-s1 px-5 py-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div>
            <p className="m-0 text-sm font-semibold tracking-tightish">Creator rewards</p>
            <p className="m-0 mt-1 text-[13px] text-t3 max-w-lg">
              LP fee share for tokens you launched is claimed from the locked Uni V3 position (locker).
              Set a rewards wallet at create time to route fees to a different address.
            </p>
          </div>
          <Link
            href="/create"
            className="shrink-0 inline-flex h-10 items-center justify-center px-4 rounded-xl border border-lime-line text-lime-t text-sm font-semibold hover:bg-lime-soft transition-colors"
          >
            Launch & set rewards
          </Link>
        </section>

        {/* Created coins */}
        <section className="border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 border-b border-hair2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Created coins</h2>
              <span className="px-2 py-0.5 rounded-full bg-s3 text-[12px] font-semibold tabular-nums text-t2">
                {profile.coinsCreated}
              </span>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search coins…"
              className="h-9 w-full sm:w-[220px] px-3 rounded-xl bg-s2 border border-hair text-sm outline-none placeholder:text-white/25 focus:border-lime-line"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-t3 text-sm">
              {profile.coinsCreated === 0
                ? 'No tokens launched from this wallet yet.'
                : 'No coins match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[12px] font-semibold text-t3 border-b border-hair2">
                    <th className="px-5 py-3 font-semibold">Coin</th>
                    <th className="px-5 py-3 font-semibold text-right">MC</th>
                    <th className="px-5 py-3 font-semibold text-right hidden sm:table-cell">Price</th>
                    <th className="px-5 py-3 font-semibold text-right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <CoinRow key={t.coinType || t.poolId || t.id} token={t} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string
  value: string
  sub: string
  href?: string
}) {
  const inner = (
    <>
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">{label}</p>
      <p className="m-0 mt-2 text-[26px] font-semibold tracking-tightish tabular-nums truncate">{value}</p>
      <p className="m-0 mt-1 text-[13px] text-t3 truncate">{sub}</p>
    </>
  )
  const cls =
    'block border border-hair rounded-[20px] bg-s1 px-5 py-4 transition-colors' +
    (href ? ' hover:border-lime-line' : '')
  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    )
  }
  return <div className={cls}>{inner}</div>
}

function CoinRow({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId || token.id
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt ?? token.lastTradeAt)

  return (
    <tr className="border-b border-hair2 last:border-0 hover:bg-white/[0.02]">
      <td className="px-5 py-3.5">
        <Link href={`/token/${address}`} className="flex items-center gap-3 min-w-0 group">
          <span
            className="relative w-10 h-10 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-sm font-bold"
            style={{ background: img ? undefined : tile, color: mono }}
          >
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              initial
            )}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold tracking-tightish truncate group-hover:text-lime-t">
              {token.name || 'Unnamed'}
            </span>
            <span className="block text-[12px] text-t3 tabular-nums">${token.symbol}</span>
          </span>
        </Link>
      </td>
      <td className="px-5 py-3.5 text-right font-semibold tabular-nums">{fmtUsd(token.marketCap)}</td>
      <td className="px-5 py-3.5 text-right tabular-nums text-t2 hidden sm:table-cell">
        {fmtUsd(token.currentPrice)}
      </td>
      <td className="px-5 py-3.5 text-right text-t3 tabular-nums">{age}</td>
    </tr>
  )
}
