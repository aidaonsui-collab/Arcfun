'use client'

/**
 * Dotted chart trail with mini Eve walking the line (featured $EVE tile).
 */
import { useEffect, useState } from 'react'

const TRAIL =
  'M-20 198 C 70 196 120 158 190 166 C 260 174 300 128 370 136 C 460 146 520 74 610 66 C 690 58 740 104 820 84 C 880 70 940 34 1040 18'

export function EveClimbTrail({ src }: { src: string }) {
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1000 240"
      preserveAspectRatio="xMinYMid slice"
      aria-hidden
    >
      <path d={TRAIL} fill="none" stroke="rgba(110,200,232,0.16)" strokeWidth="14" strokeLinecap="round" />
      <path
        id="eve-climb-path"
        d={TRAIL}
        fill="none"
        stroke="rgba(210,232,242,0.88)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="7 11"
        className="eve-trail-dash"
      />
      <g>
        {reduce ? (
          <g transform="translate(610 66)">
            <EveMarker src={src} />
          </g>
        ) : (
          <>
            <g>
              <animateMotion dur="16s" repeatCount="indefinite" rotate="auto">
                <mpath href="#eve-climb-path" />
              </animateMotion>
              <g transform="translate(0 -20)">
                <EveMarker src={src} />
              </g>
            </g>
          </>
        )}
      </g>
    </svg>
  )
}

function EveMarker({ src }: { src: string }) {
  return (
    <>
      <circle r="16" fill="#0b1218" stroke="rgba(110,200,232,0.7)" strokeWidth="1.6" />
      <image href={src} x="-12" y="-12" width="24" height="24" />
    </>
  )
}
