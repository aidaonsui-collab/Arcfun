'use client'

/**
 * ArcFun nav — single product, single chain, so this is intentionally just a wordmark,
 * "Launch" CTA, and a wallet connect/disconnect button. No multi-product tab row.
 */
import Link from 'next/link'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function SiteHeader() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  return (
    <header className="fixed top-0 inset-x-0 z-40 border-b border-white/10 bg-black/70 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="font-[family-name:var(--font-space-grotesk)] text-lg font-bold tracking-tight text-white">
            Arc<span className="text-sky-400">Fun</span>
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <Link
            href="/create"
            className="hidden sm:inline-flex px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-black text-sm font-semibold transition-colors"
          >
            Launch a token
          </Link>

          {isConnected && address ? (
            <button
              type="button"
              onClick={() => disconnect()}
              className={`px-3 py-2 rounded-xl text-sm font-mono border transition-colors ${
                wrongChain
                  ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                  : 'border-white/10 text-gray-300 bg-white/5 hover:bg-white/10'
              }`}
              title={wrongChain ? 'Wrong network — click to disconnect' : 'Connected'}
            >
              {wrongChain ? 'Wrong network' : short(address)}
            </button>
          ) : (
            <button
              type="button"
              disabled={isPending}
              onClick={() => connect({ connector: connectors[0] })}
              className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-sm font-semibold disabled:opacity-50"
            >
              {isPending ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
