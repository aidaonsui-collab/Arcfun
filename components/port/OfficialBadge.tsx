import Link from 'next/link'
import { cn } from '@/lib/cn'

function GoldCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#e2b340" />
      <path
        d="M5.6 10.4 8.3 13.1 14.4 6.9"
        fill="none"
        stroke="#1a1406"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function OfficialBadge({
  symbol,
  href,
  size = 'md',
  label = true,
}: {
  symbol?: string
  href?: string
  size?: 'sm' | 'md'
  label?: boolean
}) {
  const tick = <GoldCheck className={size === 'sm' ? 'h-3.5 w-3.5 shrink-0' : 'h-5 w-5 shrink-0'} />
  const text = symbol ? `Official $${symbol}` : 'Official'
  const body = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-semibold',
        size === 'sm' ? 'text-[12px] text-[#e2b340]' : 'text-[13px] text-[#e2b340]',
      )}
      title={text}
    >
      {tick}
      {label ? <span className="leading-none">{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  )
  if (!href) return body
  return (
    <Link href={href} className="inline-flex hover:opacity-90">
      {body}
    </Link>
  )
}
