/** Arc glyph brand mark — matches public/favicon.svg, recolored to design --limeT. */
export function BrandMark({ className = 'w-[26px] h-[26px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="32" fill="#0E0E10" />
      <path d="M32 14 L50 46 L41 46 L32 30 L23 46 L14 46 Z" fill="var(--limeT)" />
    </svg>
  )
}
