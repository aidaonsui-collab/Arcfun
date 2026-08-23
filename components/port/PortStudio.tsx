import Link from 'next/link'
import { Code2, Coins, Eye, Layers, Plus, Split } from 'lucide-react'

const MOSAIC = [
  { src: '/port/studio/rooms.jpg', alt: '' },
  { src: '/port/studio/glass.jpg', alt: '' },
  { src: '/port/studio/harbor.jpg', alt: '' },
] as const

const POINTS = [
  { icon: Code2, text: 'ERC-721 contract' },
  { icon: Coins, text: 'Mint in USDC' },
  { icon: Layers, text: 'Fixed supply and max per wallet' },
  { icon: Eye, text: 'Items show as they mint' },
  { icon: Split, text: '95% creator · 5% platform' },
] as const

export function PortStudio() {
  return (
    <section className="rise-in grid items-start gap-10 pb-6 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:gap-16 lg:pt-16">
      <div className="min-w-0 lg:pt-6">
        <h1 className="text-[40px] font-semibold leading-[1.06] tracking-display sm:text-[56px] lg:text-[64px]">
          What do you want to create?
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-t2 sm:text-[17px]">
          Collections on Arc. Creators launch. Collectors mint in USDC.
        </p>
        <Link
          href="/docs#port"
          className="mt-7 inline-flex h-11 items-center rounded-full border border-hair bg-s2 px-5 text-[13px] font-semibold text-t2 hover:border-lime-line hover:text-white"
        >
          How it works
        </Link>
      </div>

      <article className="rise-in-2 rounded-[28px] border border-hair bg-s1 p-5 sm:p-6">
        <div className="grid grid-cols-2 gap-2">
          {MOSAIC.map((img) => (
            <div
              key={img.src}
              className="aspect-square overflow-hidden rounded-2xl bg-s2 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.src} alt={img.alt} className="h-full w-full object-cover" />
            </div>
          ))}
          <Link
            href="/port/create"
            className="grid aspect-square place-items-center rounded-2xl border border-dashed border-hair bg-s2 text-t3 transition-colors hover:border-lime-line hover:text-white"
            aria-label="Create collection"
          >
            <Plus className="h-8 w-8" strokeWidth={1.6} />
          </Link>
        </div>

        <h2 className="mt-5 text-[28px] font-semibold tracking-display">Collection</h2>
        <Link
          href="/port/create"
          className="mt-4 flex h-12 w-full items-center justify-center rounded-full border border-hair bg-transparent text-[15px] font-semibold text-white hover:border-lime-line hover:bg-s2 hover:text-white"
        >
          Create collection
        </Link>
        <p className="mt-4 text-[14px] leading-relaxed text-t2">
          Publish a 721 on Arc. Set supply, price, and royalty. Items mint in USDC and show on
          ArcPort as they land.
        </p>
        <ul className="mt-5 space-y-2.5">
          {POINTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-2.5 text-[13px] text-t2">
              <Icon className="h-4 w-4 shrink-0 text-t3" strokeWidth={1.8} />
              {text}
            </li>
          ))}
        </ul>
      </article>
    </section>
  )
}

export function PortHow() {
  const steps = [
    { k: 'Launch', v: 'One transaction deploys the collection. 0.1 USDC create fee.' },
    { k: 'Mint', v: 'Collectors pay USDC. 95% to the creator, 5% to the platform.' },
    { k: 'Trade', v: 'Primary mint is live first. Secondary list and buy comes next.' },
  ]
  return (
    <section className="rise-in-3 mt-6 grid gap-3 sm:grid-cols-3">
      {steps.map((s) => (
        <div key={s.k} className="rounded-[22px] border border-hair bg-s1 px-5 py-4">
          <div className="text-[13px] font-semibold tracking-tightish text-lime-t">{s.k}</div>
          <p className="mt-1.5 mb-0 text-[13px] leading-snug text-t2">{s.v}</p>
        </div>
      ))}
    </section>
  )
}
