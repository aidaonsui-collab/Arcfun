'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export function FeaturedRail({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const sync = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 4)
    setCanRight(max > 4 && el.scrollLeft < max - 4)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [sync, children])

  const page = (dir: -1 | 1) => {
    const el = scroller.current
    if (!el) return
    const card = el.querySelector<HTMLElement>('[data-featured-card]')
    const gap = 16
    const delta = (card?.offsetWidth ?? Math.round(el.clientWidth * 0.85)) + gap
    el.scrollBy({ left: dir * delta, behavior: 'smooth' })
  }

  return (
    <div className="relative">
      <div
        ref={scroller}
        className="rail-scroll featured-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:-mx-0 sm:gap-4 sm:px-0"
      >
        {children}
      </div>
      {canLeft ? (
        <button
          type="button"
          aria-label="Previous featured collection"
          onClick={() => page(-1)}
          className="absolute left-1 top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-hair bg-[rgba(12,16,24,0.88)] text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md sm:flex"
        >
          <Arrow dir="left" />
        </button>
      ) : null}
      {canRight ? (
        <button
          type="button"
          aria-label="Next featured collection"
          onClick={() => page(1)}
          className="absolute right-1 top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-hair bg-[rgba(12,16,24,0.88)] text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md sm:flex"
        >
          <Arrow dir="right" />
        </button>
      ) : null}
    </div>
  )
}

function Arrow({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        d={dir === 'left' ? 'M12.5 4.5 7 10l5.5 5.5' : 'M7.5 4.5 13 10l-5.5 5.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
