'use client'

/**
 * Sticky nav — brand mark, search, Launch CTA, wallet chip.
 * Mobile: hamburger sheet with OTC / Launch / portfolio links.
 */
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi'
import { formatUnits } from 'viem'
import { Menu, X } from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'

/** Chains used by Arc launchpad + Arc OTC payment spokes. */
const SUPPORTED_CHAIN_IDS = new Set([
  ARC_CHAIN_ID,
  1, // Ethereum (OTC, when live)
  8453, // Base
  42161, // Arbitrum
])

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
  const pathname = usePathname()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const onArc = isConnected && chainId === ARC_CHAIN_ID
  const wrongChain = isConnected && chainId != null && !SUPPORTED_CHAIN_IDS.has(chainId)
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const { data: bal } = useBalance({
    address,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address && onArc },
  })

  // Close sheet on route change
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // Lock body scroll while open
  useEffect(() => {
    if (!menuOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [menuOpen])

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    const v = q.trim()
    if (!v) return
    setMenuOpen(false)
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
      router.push(`/token/${v}`)
      return
    }
    router.push(`/?q=${encodeURIComponent(v)}`)
  }

  const navLink = (href: string, label: string, opts?: { primary?: boolean }) => (
    <Link
      href={href}
      onClick={() => setMenuOpen(false)}
      className={
        opts?.primary
          ? 'flex h-12 items-center justify-center rounded-2xl bg-lime text-white text-[15px] font-semibold tracking-tightish hover:bg-lime-2 transition-colors'
          : 'flex h-12 items-center px-4 rounded-2xl border border-hair bg-s2 text-[15px] font-semibold text-t2 hover:text-white hover:border-lime-line transition-colors'
      }
    >
      {label}
    </Link>
  )

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-40 h-16 flex items-center gap-3 sm:gap-6 px-4 sm:px-10 bg-[rgba(10,15,24,0.82)] backdrop-blur-[28px] saturate-150 border-b border-hair2">
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
          <span className="text-[11px] font-semibold text-t3 border border-hair rounded px-1.5 py-0.5">
            /
          </span>
        </form>

        <div className="flex-1" />

        <Link
          href="/otc"
          className="hidden sm:inline-flex h-9 items-center px-3 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white hover:border-lime-line transition-colors"
        >
          Arc OTC
        </Link>

        {isConnected && address ? (
          <div className="flex items-center gap-2">
            {!wrongChain && (
              <>
                <Link
                  href="/portfolio"
                  className="hidden sm:inline-flex h-9 items-center px-3 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white hover:border-lime-line transition-colors"
                >
                  Portfolio
                </Link>
                <Link
                  href={`/creator/${address}`}
                  className="hidden sm:inline-flex h-9 items-center px-3 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white hover:border-lime-line transition-colors"
                >
                  Profile
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={() => disconnect()}
              className={`h-9 flex items-center gap-2.5 pl-3.5 pr-1.5 rounded-xl border text-sm font-semibold tabular-nums tracking-tightish transition-colors ${
                wrongChain
                  ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                  : 'border-hair bg-s2 text-white hover:bg-s3'
              }`}
              title={wrongChain ? 'Unsupported network — click to disconnect' : 'Disconnect'}
            >
              {wrongChain ? (
                'Wrong network'
              ) : (
                <>
                  {onArc ? (
                    <span className="hidden xs:inline sm:inline">{fmtBal(bal?.value)}</span>
                  ) : (
                    <span className="text-t3 text-xs">{short(address)}</span>
                  )}
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
            className="h-9 px-3 sm:px-4 rounded-xl bg-s2 border border-hair text-white text-sm font-semibold hover:bg-s3 disabled:opacity-50 transition-colors"
          >
            {isPending ? '…' : 'Connect'}
          </button>
        )}

        {/* Mobile hamburger — shown when desktop nav links are hidden */}
        <button
          type="button"
          className="sm:hidden h-9 w-9 inline-flex items-center justify-center rounded-xl border border-hair bg-s2 text-white hover:bg-s3 transition-colors"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>

        <span className="hidden" aria-hidden>
          {ARC.USDC}
        </span>
      </header>

      {/* Mobile menu sheet */}
      {menuOpen && (
        <div className="sm:hidden fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            style={{ animation: 'veil 0.15s ease-out' }}
          />
          <div className="absolute top-16 inset-x-0 border-b border-hair bg-[rgba(12,16,24,0.98)] shadow-[0_24px_48px_rgba(0,0,0,0.55)] px-4 pt-4 pb-6 flex flex-col gap-2.5 animate-[veil_0.15s_ease-out]">
            <form
              onSubmit={onSearch}
              className="flex h-11 items-center gap-2.5 px-3.5 bg-s2 border border-hair rounded-xl mb-1"
            >
              <span className="w-3.5 h-3.5 border-[1.6px] border-t3 rounded-full shrink-0" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tokens or addresses"
                className="flex-1 bg-transparent border-0 outline-none text-sm tracking-tightish placeholder:text-white/25"
                autoFocus
              />
            </form>

            {navLink('/', 'Home')}
            {navLink('/docs', 'Docs')}
            {navLink('/otc', 'Arc OTC')}
            {navLink('/create', 'Launch a token', { primary: true })}
            {isConnected && address && !wrongChain && (
              <>
                {navLink('/portfolio', 'Portfolio')}
                {navLink(`/creator/${address}`, 'Profile')}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
