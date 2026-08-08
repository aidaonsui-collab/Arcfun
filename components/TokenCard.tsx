import Link from 'next/link'
import type { PoolToken } from '@/lib/tokens'

function fmtUsd(n: number): string {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

export function TokenCard({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId
  return (
    <Link
      href={`/token/${address}`}
      className="group rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-sky-500/30 transition-colors p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl overflow-hidden bg-white/5 shrink-0 flex items-center justify-center text-sm font-bold text-gray-500">
          {token.imageUrl || token.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={token.imageUrl || token.logoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            (token.symbol || '?').slice(0, 2)
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{token.name || 'Unnamed'}</p>
          <p className="text-xs text-gray-500 truncate">${token.symbol}</p>
        </div>
      </div>
      {token.description && <p className="text-xs text-gray-500 line-clamp-2">{token.description}</p>}
      <div className="flex items-center justify-between text-xs text-gray-500 mt-auto pt-1 border-t border-white/5">
        <span>Mkt cap {fmtUsd(token.marketCap)}</span>
        <span className="text-sky-400 group-hover:text-sky-300">Instant DEX ⚡</span>
      </div>
    </Link>
  )
}
