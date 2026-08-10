'use client'

/**
 * Sticky nav — brand mark, search, Launch CTA, wallet chip.
 * Matches Arcfun redesign handoff desktop header.
 */
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'
import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi'
import { formatUnits } from 'viem'
import { BrandMark } from '@/components/BrandMark'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function fmtBal(raw: bigint | undefined): string {
  if (raw == null) return '—'
  // Arc native USDC is 18dp; ERC-20 USDC is 6dp — balance here is native gas token.
  const n = Number(formatUnits(raw, 18))
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

export function SiteHeader() {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const [q, setQ] = useState('')

  const { data: bal } = useBalance({
    address,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address && chainId === ARC_CHAIN_ID },
  })

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    const v = q.trim()
    if (!v) return
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
      router.push(`/token/${v}`)
      return
    }
    router.push(`/?q=${encodeURIComponent(v)}`)
  }

  return (
    <header className="fixed top-0 inset-x-0 z-40 h-16 flex items-center gap-4 sm:gap-6 px-4 sm:px-10 bg-[rgba(10,15,24,0.82)] backdrop-blur-[28px] saturate-150 border-b border-hair2">
      <Link href="/" className="flex items-center gap-2.5 shrink-0">
        <BrandMark />
        <span className="text-[17px] font-semibold tracking-tightish text-white">Arcfun</span>
      </Link>

      <form
        onSubmit={onSearch}
        className="hidden md:flex flex-1 max-w-[460px] h-9 items-center gap-2.5 px-3.5 bg-s2 border border-hair rounded-xl"
      >
        <span className="w-3.5 h-3.5 border-[1.6px] border-t3 rounded-full shrink-0" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tokens, tickers, addresses"
          className="flex-1 bg-transparent border-0 outline-none text-sm tracking-tightish placeholder:text-white/25"
        />
        <span className="text-[11px] font-semibold text-t3 border border-hair rounded px-1.5 py-0.5">/</span>
      </form>

      <div className="flex-1" />

      <Link
        href="/create"
        className="hidden sm:inline-flex h-9 items-center px-[18px] rounded-xl bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
      >
        Launch a token
      </Link>

      {isConnected && address ? (
        <div className="flex items-center gap-2">
          {!wrongChain && (
            <Link
              href={`/creator/${address}`}
              className="hidden sm:inline-flex h-9 items-center px-3 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white hover:border-lime-line transition-colors"
            >
              Profile
            </Link>
          )}
          <button
            type="button"
            onClick={() => disconnect()}
            className={`h-9 flex items-center gap-2.5 pl-3.5 pr-1.5 rounded-xl border text-sm font-semibold tabular-nums tracking-tightish transition-colors ${
              wrongChain
                ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                : 'border-hair bg-s2 text-white hover:bg-s3'
            }`}
            title={wrongChain ? 'Wrong network — click to disconnect' : 'Disconnect'}
          >
            {wrongChain ? (
              'Wrong network'
            ) : (
              <>
                <span>{fmtBal(bal?.value)}</span>
                <span
                  className="w-6 h-6 rounded-lg shrink-0"
                  style={{ background: 'linear-gradient(140deg,#6DB3F2,#1D5FA8)' }}
                  title={short(address)}
                />
              </>
            )}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={isPending}
          onClick={() => connect({ connector: connectors[0] })}
          className="h-9 px-4 rounded-xl bg-s2 border border-hair text-white text-sm font-semibold hover:bg-s3 disabled:opacity-50 transition-colors"
        >
          {isPending ? 'Connecting…' : 'Connect'}
        </button>
      )}

      {/* invisible USDC address ref for tree-shaking clarity if needed later */}
      <span className="hidden" aria-hidden>
        {ARC.USDC}
      </span>
    </header>
  )
}
