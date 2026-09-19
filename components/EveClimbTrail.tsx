'use client'

/**
 * Dotted chart trail with voxel Eve running the line (featured $EVE tile).
 */
import { useEffect, useRef, useState } from 'react'

const TRAIL =
  'M-20 198 C 70 196 120 158 190 166 C 260 174 300 128 370 136 C 460 146 520 74 610 66 C 690 58 740 104 820 84 C 880 70 940 34 1040 18'

export function EveClimbTrail() {
  const pathRef = useRef<SVGPathElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const eveRef = useRef<HTMLDivElement>(null)
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const path = pathRef.current
    const eve = eveRef.current
    const wrap = wrapRef.current
    if (!path || !eve || !wrap) return

    const svg = path.ownerSVGElement
    if (!svg) return

    const place = (u: number) => {
      const len = path.getTotalLength()
      if (!(len > 0)) return
      const d = u * len
      const p = path.getPointAtLength(d)
      const p2 = path.getPointAtLength(Math.min(len, d + 6))
      let ang = (Math.atan2(p2.y - p.y, p2.x - p.x) * 180) / Math.PI
      ang = Math.max(-28, Math.min(28, ang))
      const ctm = path.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = p.x
      pt.y = p.y
      const sp = pt.matrixTransform(ctm)
      const box = wrap.getBoundingClientRect()
      const x = sp.x - box.left
      const y = sp.y - box.top
      eve.style.transform = `translate(${x}px, ${y}px) translate(-50%, -88%) rotate(${ang}deg)`
    }

    if (reduce) {
      place(0.62)
      return
    }

    const dur = 16_000
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      place(((now - t0) % dur) / dur)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onResize = () => place(((performance.now() - t0) % dur) / dur)
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [reduce])

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 240" preserveAspectRatio="xMinYMid slice">
        <path d={TRAIL} fill="none" stroke="rgba(110,200,232,0.16)" strokeWidth="14" strokeLinecap="round" />
        <path
          ref={pathRef}
          d={TRAIL}
          fill="none"
          stroke="rgba(210,232,242,0.88)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="7 11"
          className="eve-trail-dash"
        />
      </svg>
      <div ref={eveRef} className="absolute left-0 top-0 will-change-transform" style={{ transformOrigin: '50% 100%' }}>
        <div className={reduce ? 'eve-runner eve-runner-still' : 'eve-runner'} />
      </div>
    </div>
  )
}
