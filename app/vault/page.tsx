import type { Metadata } from 'next'
import Link from 'next/link'

export const revalidate = 60

export const metadata: Metadata = {
  title: 'Eve Vault — Arcfun',
  description:
    'When RWAs land on Arc, Eve creator rewards buy them into a vault. Stub only — no fees move yet.',
}

/**
 * Product stub only. No fee routing, no vault contract, no keeper.
 * Creator USDC still follows Instant / EveBurn / Crucible as today.
 */
const TILES = [
  { label: 'TVL', value: '—', sub: 'waiting on Arc RWA' },
  { label: 'USDC routed', value: '$0', sub: 'creator fees → vault' },
  { label: 'RWA held', value: '—', sub: 'none approved yet' },
  { label: 'Status', value: 'Stub', sub: 'no fees move yet' },
] as const

export default function EveVaultPage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-8 sm:py-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        <div className="inline-flex items-center gap-2 rounded-full border border-hair bg-s2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
          Coming online
        </div>

        <h1 className="m-0 mt-4 text-[32px] sm:text-[40px] font-semibold tracking-display leading-[1.12] text-white">
          Eve Vault
        </h1>
        <p className="m-0 mt-3 text-[18px] font-semibold tracking-tightish text-white">
          Creator fees into real assets — when Arc has them.
        </p>
        <p className="mt-3 mb-0 max-w-2xl text-[16px] text-t2 leading-relaxed">
          Loopr-style idea, Arcfun-shaped: when tokenized RWAs (e.g. BUIDL) are live on Arc,
          Eve&apos;s Instant creator USDC can buy into a curated vault instead of sitting idle.
          This page is a shell. No fee split changes. No money moves.
        </p>

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px bg-hair2 border border-hair rounded-[24px] overflow-hidden">
          {TILES.map((m) => (
            <div key={m.label} className="px-5 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0">
              <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 whitespace-nowrap">
                {m.label}
              </span>
              <span className="text-2xl font-semibold tabular-nums tracking-[-0.028em] leading-tight truncate">
                {m.value}
              </span>
              <span className="text-xs font-semibold tabular-nums text-t3">{m.sub}</span>
            </div>
          ))}
        </div>

        <section className="mt-5 border border-hair rounded-[24px] bg-s1 p-5 sm:p-6">
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">How it would work</h2>
          <ol className="mt-3 mb-0 pl-5 text-[14px] text-t2 leading-relaxed space-y-2">
            <li>Eve Instant creator fees collect as USDC (today: MonLock 70% creator leg).</li>
            <li>When an Arc RWA is approved, a keeper buys it and deposits into an ERC-4626 vault.</li>
            <li>Vault TVL and holdings show here. Optional later: leave a slice cooking $EVE.</li>
          </ol>
          <p className="mt-4 mb-0 text-[13px] text-t3 leading-snug">
            Not live. Fee routing needs an explicit yes before any contract or env change.
            Public Arc RWAs are expected around Circle&apos;s Sep 16 mainnet window.
          </p>
        </section>

        <section className="mt-5 border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-4 border-b border-hair2">
            <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Approved RWAs</h2>
            <p className="m-0 mt-0.5 text-[13px] text-t3">Empty until something ships on 5042.</p>
          </div>
          <p className="px-5 py-12 text-center text-sm text-t3">No RWA markets yet.</p>
        </section>

        <p className="mt-6 mb-0 text-[14px] text-t3">
          Sibling product:{' '}
          <Link href="/crucible" className="text-t2 hover:text-white font-semibold">
            The Crucible
          </Link>{' '}
          — pad-wide buy/burn of $EVE.
        </p>
      </div>
    </main>
  )
}
