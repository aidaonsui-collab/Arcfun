'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileText, LayoutGrid, Plus, Rocket, User } from 'lucide-react'
import { cn } from '@/lib/cn'

const PRIMARY = [
  { href: '/studio', label: 'Collections', icon: LayoutGrid, match: (p: string) => p === '/studio' || /^\/studio\/0x/i.test(p) },
  { href: '/studio/create', label: 'Create', icon: Plus, match: (p: string) => p.startsWith('/studio/create'), accent: true },
  { href: '/studio/me', label: 'You', icon: User, match: (p: string) => p.startsWith('/studio/me') || p.startsWith('/studio/u/') },
] as const

const MORE = [
  { href: '/', label: 'Launches', icon: Rocket, match: (p: string) => p === '/' },
  { href: '/docs#studio', label: 'Docs', icon: FileText, match: (p: string) => p.startsWith('/docs') },
] as const

export function StudioRail() {
  const pathname = usePathname()

  return (
    <aside
      className="group/rail fixed bottom-5 left-3 top-20 z-30 hidden w-16 flex-col overflow-hidden rounded-[28px] border border-hair bg-[rgba(12,16,24,0.92)] shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-[width] duration-200 ease-out hover:w-[200px] focus-within:w-[200px] lg:flex"
      aria-label="ArcStudio"
    >
      <nav className="flex min-h-0 flex-1 flex-col gap-1 p-2">
        {PRIMARY.map((item) => (
          <RailLink key={item.href} {...item} active={item.match(pathname)} />
        ))}
        <div className="mx-2 my-2 h-px bg-hair" />
        {MORE.map((item) => (
          <RailLink key={item.href} {...item} active={item.match(pathname)} />
        ))}
      </nav>
      <p className="mb-3 truncate px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-t3 opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
        ArcStudio
      </p>
    </aside>
  )
}

function RailLink({
  href,
  label,
  icon: Icon,
  active,
  accent,
}: {
  href: string
  label: string
  icon: typeof LayoutGrid
  active: boolean
  accent?: boolean
}) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(
        'flex h-12 shrink-0 items-center gap-3 rounded-2xl px-[13px] text-[13px] font-semibold tracking-tightish transition-colors',
        accent && !active
          ? 'bg-lime text-white hover:bg-lime-2'
          : active
            ? 'border border-lime-line bg-s2 text-white'
            : 'text-t2 hover:bg-s2 hover:text-white',
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 truncate opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
        {label}
      </span>
    </Link>
  )
}
