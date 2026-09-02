'use client'

import { useLayoutEffect, useRef } from 'react'

/**
 * FLIP-animate children marked `[data-flip-id]` when `ids` order/membership changes.
 * Same idea as Vicefun's explore list (`paintExploreList` in the-arena/index.html):
 * invert from the previous rect, then play transform/opacity.
 */
export function useFlipGrid(ids: string[]) {
  const rootRef = useRef<HTMLDivElement>(null)
  const prevRects = useRef<Map<string, DOMRect>>(new Map())
  const primed = useRef(false)
  const sig = ids.join('|')

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-id]'))
    const next = new Map<string, DOMRect>()
    for (const el of nodes) {
      const id = el.getAttribute('data-flip-id') || ''
      if (id) next.set(id, el.getBoundingClientRect())
    }

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const first = !primed.current || prevRects.current.size === 0
    primed.current = true

    if (first || reduce) {
      prevRects.current = next
      return
    }

    const from = prevRects.current
    const moving: HTMLElement[] = []
    const entering: HTMLElement[] = []

    for (const el of nodes) {
      const id = el.getAttribute('data-flip-id') || ''
      const last = next.get(id)
      const prev = from.get(id)
      el.classList.remove('flip-move', 'flip-enter')
      el.style.transition = 'none'
      el.style.transform = ''
      if (!last) continue
      if (!prev) {
        el.classList.add('flip-enter')
        entering.push(el)
        continue
      }
      const dx = prev.left - last.left
      const dy = prev.top - last.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`
      el.classList.add('flip-move')
      moving.push(el)
    }

    void root.offsetWidth

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const el of [...moving, ...entering, ...nodes]) {
          el.style.transition = ''
          el.style.transform = ''
        }
        for (const el of entering) el.classList.remove('flip-enter')
        window.setTimeout(() => {
          for (const el of moving) el.classList.remove('flip-move')
        }, 480)
      })
    })

    prevRects.current = next
  }, [sig])

  return rootRef
}
