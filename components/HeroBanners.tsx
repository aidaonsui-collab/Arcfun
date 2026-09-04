'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'

type PairMark = {
  id: string
  ticker: string
  image: string
  bg: string
}

const DECK: PairMark[] = [
  { id: 'usyc', ticker: 'USYC', image: '/marks/usyc.png', bg: '#0a1628' },
  { id: 'buidl', ticker: 'BUIDL', image: '/marks/buidl.png', bg: '#0b0b0d' },
  { id: 'crcl', ticker: 'CRCL', image: '/marks/crcl.svg', bg: '#0c0e14' },
  { id: 'usdc', ticker: 'USDC', image: '/marks/usdc.png', bg: '#0a1a33' },
]

const POSES = [
  { x: 18, y: -6, r: 7 },
  { x: 10, y: 4, r: 1 },
  { x: 2, y: 14, r: -5 },
  { x: -6, y: 24, r: -10 },
] as const

export function HeroBanners() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="relative overflow-hidden rounded-[24px] bg-s1 px-5 py-7 sm:px-7 sm:py-8 min-h-52 border border-hair">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 78% 86% at 92% 78%, rgba(47, 132, 219, 0.22) 0%, rgba(47, 132, 219, 0.08) 42%, transparent 70%), radial-gradient(ellipse 55% 70% at 88% 50%, rgba(126, 192, 247, 0.10) 0%, transparent 62%)',
          }}
        />
        <div className="relative z-10 md:max-w-[19rem]">
          <h1 className="m-0 text-[1.7rem] leading-tight font-semibold tracking-tight text-pretty md:text-[1.9rem]">
            Launch on Arc.
            <br />
            Pair it to Stocks.
          </h1>
          <div className="mt-6 flex items-center justify-between gap-3 md:block">
            <Link
              href="/create"
              className="inline-flex h-11 shrink-0 items-center px-6 rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
            >
              Launch now
            </Link>
            <DealDeck />
          </div>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[24px] bg-s2 px-7 py-8 min-h-52 border border-hair">
        <div className="relative z-10 max-w-[18rem]">
          <h2 className="m-0 text-[1.7rem] leading-tight font-semibold tracking-tight text-pretty md:text-[1.9rem]">
            $EVE’s Crucible.
          </h2>
          <p className="mt-2 mb-0 text-sm text-t2">The financial structure</p>
          <Link
            href="/crucible"
            className="mt-6 inline-flex h-11 items-center px-6 rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
          >
            Open
          </Link>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 select-none text-[5.5rem] font-semibold tracking-tighter text-white/[0.08] md:right-8 md:text-[6.5rem]"
        >
          BURN
        </div>
        <svg
          aria-hidden
          viewBox="0 0 240 240"
          className="pointer-events-none absolute -right-8 -bottom-10 size-56 text-lime-t/20"
        >
          <circle cx="120" cy="120" r="90" fill="none" stroke="currentColor" strokeWidth="1" />
          <circle cx="120" cy="120" r="62" fill="none" stroke="currentColor" strokeWidth="1" />
          <path
            d="M40 150a90 90 0 0 1 160 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      </div>
    </div>
  )
}

function DealDeck() {
  const [deck, setDeck] = useState<PairMark[]>(DECK)
  const [outId, setOutId] = useState<string | null>(null)
  const deckRef = useRef(deck)
  deckRef.current = deck

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    let dealTimer = 0
    let gapTimer = 0
    let alive = true

    const cycle = () => {
      const top = deckRef.current[0]
      if (!top) return
      setOutId(top.id)
      setDeck((d) => (d.length ? [...d.slice(1), d[0]!] : d))
      dealTimer = window.setTimeout(() => {
        setOutId(null)
        if (alive) gapTimer = window.setTimeout(cycle, 480)
      }, 680)
    }

    gapTimer = window.setTimeout(cycle, 420)
    return () => {
      alive = false
      window.clearTimeout(dealTimer)
      window.clearTimeout(gapTimer)
    }
  }, [])

  const stacked = outId ? deck.filter((t) => t.id !== outId) : deck
  const flying = outId ? deck.find((t) => t.id === outId) : undefined
  const flyPose = POSES[0]

  return (
    <div
      aria-hidden
      className="pointer-events-none relative h-28 w-32 shrink-0 origin-right scale-90 md:absolute md:top-1/2 md:right-10 md:h-36 md:w-44 md:-translate-y-1/2 md:scale-100"
    >
      {stacked.map((token, i) => {
        const pose = POSES[i] ?? POSES[POSES.length - 1]
        return (
          <MiniCard
            key={token.id}
            token={token}
            x={pose.x}
            y={pose.y}
            r={pose.r}
            z={stacked.length - i}
          />
        )
      })}
      {flying ? (
        <MiniCard
          key={`${flying.id}-fly`}
          token={flying}
          x={flyPose.x}
          y={flyPose.y}
          r={flyPose.r}
          z={40}
          flying
        />
      ) : null}
    </div>
  )
}

function MiniCard({
  token,
  x,
  y,
  r,
  z,
  flying,
}: {
  token: PairMark
  x: number
  y: number
  r: number
  z: number
  flying?: boolean
}) {
  return (
    <div
      className={`deal-card h-24 w-16${flying ? ' is-out' : ''}`}
      style={
        {
          zIndex: z,
          background: token.bg,
          '--sx': `${x}px`,
          '--sy': `${y}px`,
          '--sr': `${r}deg`,
        } as CSSProperties
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={token.image} alt="" className="size-full object-contain p-1" />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent pb-1.5 pt-6 text-center">
        <span className="text-xs font-medium tracking-wider text-white">{token.ticker}</span>
      </div>
    </div>
  )
}
