'use client'

/**
 * Sticky nav — eve.fun brand mark + wordmark, Studio, Profile, wallet chip.
 * Mobile: Home, ArcStudio, Create collection, Profile, Docs.
 */
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import {
  BookOpen,
  CircleUser,
  Home,
  LayoutGrid,
  Menu,
  PlusCircle,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { WalletButton } from '@/components/WalletButton'
import { connectToArc } from '@/lib/arc-wallet'
import { ARC } from '@/lib/contracts-arc'
import { EVE_TOKEN } from '@/lib/eve'

export function SiteHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Close sheet on route change
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  const onEve = pathname.toLowerCase().includes(EVE_TOKEN.toLowerCase())
  const onDocs = pathname.startsWith('/docs')
  const onCreate = pathname.startsWith('/create')
  const onStudio = pathname.startsWith('/studio')
  const onProfile =
    pathname.startsWith('/creator') ||
    pathname.startsWith('/portfolio') ||
    pathname === '/studio/me'
  const profileHref =
    isConnected && address ? (onStudio ? '/studio/me' : `/creator/${address}`) : '/portfolio'

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
      <header className="fixed top-0 inset-x-0 z-40 h-16 bg-[rgba(7,11,20,0.82)] backdrop-blur-[28px] saturate-150">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          className="md:hidden h-9 w-9 -ml-1 shrink-0 inline-flex items-center justify-center rounded-xl text-white active:bg-white/10 transition-colors"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-6 h-6" />}
        </button>

        <Link href="/" className="flex items-center gap-2 shrink-0">
          <BrandMark className="w-6 h-6" />
          <span className="text-[17px] font-semibold tracking-tight">
            <span style={{ color: "#2775CA" }}>eve</span>
            <span style={{ color: "#7CFF3A" }}>.fun</span>
          </span>
        </Link>

        <nav className="ml-3 hidden items-center gap-1 md:flex">
          <Link
            href={`/token/${EVE_TOKEN}`}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${onEve ? 'text-white' : 'text-t2 hover:text-white'}`}
          >
            $EVE
          </Link>
          <Link
            href="/docs"
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${onDocs ? 'text-white' : 'text-t2 hover:text-white'}`}
          >
            Docs
          </Link>
          <Link
            href="/studio"
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${onStudio ? 'text-white' : 'text-t2 hover:text-white'}`}
          >
            Studio
          </Link>
          <Link
            href={profileHref}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${onProfile ? 'text-white' : 'text-t2 hover:text-white'}`}
          >
            Profile
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <form onSubmit={onSearch} className="hidden sm:block">
            <label className="flex h-9 w-full max-w-xs min-w-44 items-center gap-2 rounded-full bg-s2 px-3 text-xs text-t3 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)] focus-within:text-white">
              <Search className="size-3.5 shrink-0" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tokens"
                className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-t3"
              />
              <kbd className="hidden rounded-md bg-s1 px-1.5 py-0.5 font-mono text-[10px] text-t3 lg:inline">⌘K</kbd>
            </label>
          </form>
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-s2 px-3 py-1.5 text-xs text-t2 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
            <span className="live-dot size-1.5 rounded-full bg-fun" />
            Arc
          </span>
          <WalletButton />
          <Link
            href="/create"
            className={`hidden h-9 items-center rounded-full bg-lime px-4 text-sm font-semibold text-accent-fg hover:bg-lime-2 sm:inline-flex ${onCreate ? 'ring-1 ring-white/20' : ''}`}
          >
            Launch token
          </Link>
        </div>

        <span className="hidden" aria-hidden>
          {ARC.USDC}
        </span>
        </div>
      </header>

      {/* Mobile nav drawer — full-width right slide-in, matching OpenSea's mobile menu:
          brand top-left, close top-right, icon+label rows separated by dividers, and a rule
          between the site nav and the account group. */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
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
                <span className="text-[20px] font-bold tracking-tightish">
                  <span style={{ color: "#2775CA" }}>eve</span>
                  <span style={{ color: "#7CFF3A" }}>.fun</span>
                </span>
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
              {navRow(`/token/${EVE_TOKEN}`, '$EVE', Sparkles)}
              {navRow('/create', 'Launch token', PlusCircle)}
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
