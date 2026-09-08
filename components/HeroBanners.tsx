'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { PadVolumeTile } from '@/components/PadVolumeTile'

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

export function HeroBanners({
  volume24h = 0,
  volumeAll = 0,
}: {
  volume24h?: number
  volumeAll?: number
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 md:items-stretch">
      <div className="relative overflow-hidden rounded-[24px] bg-s1 px-5 py-7 sm:px-7 sm:py-8 min-h-52 border border-hair">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 62% 88% at 84% 54%, rgba(47, 132, 219, 0.26) 0%, rgba(47, 132, 219, 0.10) 38%, transparent 70%), radial-gradient(ellipse 42% 58% at 90% 46%, rgba(126, 192, 247, 0.12) 0%, transparent 62%)',
          }}
        />
        {/* Do not make this inner column `relative`: DealDeck is md:absolute against the banner. */}
        <div className="md:max-w-[19rem]">
          <h1 className="relative z-10 m-0 text-[1.7rem] leading-tight font-semibold tracking-tight text-pretty md:text-[1.9rem]">
            Launch on Arc.
            <br />
            Pair it to Money Market Funds.
          </h1>
          <div className="mt-6 flex items-center justify-between gap-3 md:block">
            <Link
              href="/create"
              className="relative z-10 inline-flex h-11 shrink-0 items-center px-6 rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
            >
              Launch now
            </Link>
            <DealDeck />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center md:min-h-52">
        <PadVolumeTile volume24h={volume24h} volumeAll={volumeAll} />
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
