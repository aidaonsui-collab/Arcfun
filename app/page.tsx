'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Loader2, Rocket } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import { TokenCard } from '@/components/TokenCard'
import { coalescedFetch } from '@/lib/coalesced-fetch'

export default function HomePage() {
  const [tokens, setTokens] = useState<PoolToken[]>([])
  const [loading, setLoading] = useState(true)

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

  const sorted = [...tokens].sort((a, b) => (b.lastTradeAt ?? b.createdAt ?? 0) - (a.lastTradeAt ?? a.createdAt ?? 0))

  return (
    <main className="min-h-screen bg-black text-white px-4 pt-24 pb-16">
      <div className="max-w-6xl mx-auto">
        <section className="py-14 sm:py-20 text-center space-y-5">
          <h1 className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-bold tracking-tight">
            Launch a token on <span className="text-sky-400">Arc</span>
          </h1>
          <p className="text-gray-400 max-w-xl mx-auto">
            One transaction. Full supply straight onto Uniswap V3, quoted in USDC. LP locked a year, no presale.
          </p>
          <Link
            href="/create"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-black font-semibold transition-colors"
          >
            <Rocket className="w-4 h-4" /> Launch a token
          </Link>
        </section>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Live on Arc</h2>
            {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-600" />}
          </div>

          {!loading && sorted.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center text-gray-500 text-sm">
              Nothing launched yet — be the first.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sorted.map((t) => (
                <TokenCard key={t.id || t.coinType || t.poolId} token={t} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
