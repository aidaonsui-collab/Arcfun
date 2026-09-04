'use client'

/**
 * Sticky nav — Arcfun brand mark + wordmark, search, Vault, ArcStudio, wallet chip.
 * Mobile: Home, Crucible, Eve Vault, ArcStudio, Create collection, Profile, Docs.
 */
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import {
  BookOpen,
  CircleUser,
  Flame,
  Home,
  Landmark,
  LayoutGrid,
  Menu,
  PlusCircle,
  X,
  type LucideIcon,
} from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { CrucibleChip } from '@/components/CrucibleChip'
import { WalletButton } from '@/components/WalletButton'
import { connectToArc } from '@/lib/arc-wallet'
import { ARC } from '@/lib/contracts-arc'

export function SiteHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  // Close sheet on route change
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // Lock body scroll while open, and publish the REAL visible height as --vvh.
  //
  // The drawer can't use 100vh: on iOS Safari that resolves to the toolbar-hidden height, so the
  // panel runs under the address bar and its bottom entries can't be tapped. 100dvh fixes that on
  // iOS 16.4+, and is the CSS fallback here — visualViewport.height covers older versions and also
  // tracks the on-screen keyboard, which dvh does not.
  useEffect(() => {
    if (!menuOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const syncHeight = () => {
      const h = vv?.height ?? window.innerHeight
      if (h > 0) document.documentElement.style.setProperty('--vvh', `${h}px`)
    }
    syncHeight()
    vv?.addEventListener('resize', syncHeight)
    vv?.addEventListener('scroll', syncHeight)

    return () => {
      document.body.style.overflow = prev
      vv?.removeEventListener('resize', syncHeight)
      vv?.removeEventListener('scroll', syncHeight)
      document.documentElement.style.removeProperty('--vvh')
    }
  }, [menuOpen])

  const onStudio = pathname.startsWith('/studio')
  const onVault = pathname.startsWith('/vault')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    const v = q.trim()
    if (!v) return
    setMenuOpen(false)
    if (onStudio) {
      router.push(`/studio?q=${encodeURIComponent(v)}`)
      return
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
      router.push(`/token/${v}`)
      return
    }
    router.push(`/?q=${encodeURIComponent(v)}`)
  }

  /** OpenSea-style drawer row: circular outlined icon + label, flat with a divider — not a pill. */
  const navRow = (href: string, label: string, Icon: LucideIcon) => (
    <Link
      href={href}
      onClick={() => setMenuOpen(false)}
      className="flex items-center gap-4 px-5 h-[68px] border-b border-hair2 text-[17px] font-semibold text-white active:bg-white/5 transition-colors"
    >
      <span className="w-11 h-11 shrink-0 rounded-full border border-hair flex items-center justify-center text-t2">
        <Icon className="w-5 h-5" />
      </span>
      {label}
    </Link>
  )

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-40 h-16 flex items-center gap-3 sm:gap-6 px-4 sm:px-10 bg-[rgba(10,15,24,0.82)] backdrop-blur-[28px] saturate-150 border-b border-hair2">
        {/* Menu button sits LEFT of the brand on mobile, matching OpenSea. Desktop is unchanged —
            it shows the real nav links instead, so this is sm:hidden. */}
        <button
          type="button"
          className="sm:hidden h-9 w-9 -ml-1 shrink-0 inline-flex items-center justify-center rounded-xl text-white active:bg-white/10 transition-colors"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-6 h-6" />}
        </button>

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
            placeholder="Search tokens, collections, addresses"
            className="flex-1 bg-transparent border-0 outline-none text-sm tracking-tightish placeholder:text-white/25"
          />
          <span className="text-[11px] font-semibold text-t3 border border-hair rounded px-1.5 py-0.5">
            /
          </span>
        </form>

        <div className="flex-1" />

        <CrucibleChip compact className="hidden lg:inline-flex" />

        <Link
          href="/vault"
          className={`hidden sm:inline-flex h-9 items-center px-3 rounded-xl border text-sm font-semibold transition-colors ${
            onVault
              ? 'border-lime-line bg-s2 text-white'
              : 'border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line'
          }`}
        >
          Vault
        </Link>

        <Link
          href="/studio"
          className={`hidden sm:inline-flex h-9 items-center px-3 rounded-xl border text-sm font-semibold transition-colors ${
            onStudio
              ? 'border-lime-line bg-s2 text-white'
              : 'border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line'
          }`}
        >
          Studio
        </Link>

        {isConnected && address ? (
          <Link
            href={onStudio ? '/studio/me' : `/creator/${address}`}
            className={`hidden sm:inline-flex h-9 items-center px-3 rounded-xl border text-sm font-semibold transition-colors ${
              pathname.startsWith('/portfolio') ||
              pathname.toLowerCase() === `/creator/${address.toLowerCase()}` ||
              (onStudio && pathname.startsWith('/studio/me'))
                ? 'border-lime-line bg-s2 text-white'
                : 'border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line'
            }`}
          >
            Profile
          </Link>
        ) : null}
        <WalletButton />

        <span className="hidden" aria-hidden>
          {ARC.USDC}
        </span>
      </header>

      {/* Mobile nav drawer — full-width right slide-in, matching OpenSea's mobile menu:
          brand top-left, close top-right, icon+label rows separated by dividers, and a rule
          between the site nav and the account group. */}
      {menuOpen && (
        <div className="sm:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <aside
            className="nav-drawer absolute inset-0 w-full flex flex-col bg-[var(--bg)]"
            style={{
              // Not h-full/100vh: on iOS Safari 100vh is the toolbar-HIDDEN height, so the panel
              // would run under the address bar and its bottom rows would be untappable. --vvh is
              // the live visualViewport height (see the effect above); 100dvh is the CSS fallback.
              height: 'var(--vvh, 100dvh)',
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            <div className="flex items-center justify-between h-16 px-5 shrink-0">
              <Link href="/" onClick={() => setMenuOpen(false)} className="flex items-center gap-2.5">
                <BrandMark />
                <span className="text-[20px] font-bold tracking-tightish text-white">Arcfun</span>
              </Link>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-hair text-white active:bg-white/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain border-t border-hair2">
              <form onSubmit={onSearch} className="px-5 py-4 border-b border-hair2">
                <div className="flex h-12 items-center gap-2.5 px-4 bg-s2 border border-hair rounded-full">
                  <span className="w-4 h-4 border-[1.6px] border-t3 rounded-full shrink-0" aria-hidden />
                  {/* text-base (16px) is load-bearing, not styling: iOS Safari force-zooms the page
                      on focus for any input under 16px. That, plus the autoFocus this used to have,
                      is why opening the menu landed zoomed into the search field. */}
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search tokens, collections"
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-base tracking-tightish placeholder:text-white/30"
                  />
                </div>
              </form>

              {navRow('/', 'Home', Home)}
              {navRow('/crucible', 'Crucible', Flame)}
              {navRow('/vault', 'Eve Vault', Landmark)}
              {navRow('/studio', 'Studio', LayoutGrid)}
              {navRow('/studio/create', 'Create collection', PlusCircle)}

              {/* Account group, separated by a heavier rule like OpenSea's */}
              <div className="h-2 bg-black/30 border-y border-hair2" aria-hidden />

              {isConnected && address ? (
                navRow(onStudio ? '/studio/me' : `/creator/${address}`, 'Profile', CircleUser)
              ) : (
                // No address yet to link /creator/[address] to — prompt connect instead of hiding
                // the entry, so Profile keeps its place in the order.
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    setMenuOpen(false)
                    connectToArc(connect, connectors)
                  }}
                  className="w-full flex items-center gap-4 px-5 h-[68px] border-b border-hair2 text-[17px] font-semibold text-white active:bg-white/5 transition-colors disabled:opacity-50"
                >
                  <span className="w-11 h-11 shrink-0 rounded-full border border-hair flex items-center justify-center text-t2">
                    <CircleUser className="w-5 h-5" />
                  </span>
                  {isPending ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
              {navRow('/docs', 'Docs', BookOpen)}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
