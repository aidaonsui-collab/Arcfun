import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Legacy Instant — eve.fun',
  description: 'Crucible was the V3 Instant fee cook. New launches use Uniswap v4 pool fees.',
}

export default function CrucibleLegacyPage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-10">
        <p className="m-0 text-xs font-medium tracking-[0.16em] text-t3 uppercase">Legacy</p>
        <h1 className="mt-2 mb-0 text-3xl font-semibold tracking-tight">Crucible is not a live product</h1>
        <p className="mt-4 text-[15px] text-t2 leading-relaxed">
          New Instant launches pick a pool fee on Uniswap v4 (creator / burn / holders / auto-LP /
          eve.fun). There is no $EVE cook on those pools.
        </p>
        <p className="mt-3 text-[15px] text-t2 leading-relaxed">
          Tokens already live on V3 Instant still lock through CrucibleLock. The keeper keeps
          collecting those positions, running project burn, and cooking $EVE for that book only.
        </p>
        <p className="mt-8 mb-0">
          <Link href="/create" className="text-lime-t font-semibold hover:text-white">
            Launch a token
          </Link>
          <span className="text-t3"> · </span>
          <Link href="/docs#fees" className="text-lime-t font-semibold hover:text-white">
            Fee docs
          </Link>
        </p>
      </div>
    </main>
  )
}
