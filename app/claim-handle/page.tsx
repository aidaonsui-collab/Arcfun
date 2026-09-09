import type { Metadata } from 'next'
import { HandlePayClaimCard } from '@/components/HandlePayClaimCard'

export const metadata: Metadata = {
  title: 'Pay to @handle — eve.fun',
  description: 'Claim Instant creator LP fees routed to an X handle vault.',
}

export default function ClaimHandlePage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-[520px] mx-auto px-4 sm:px-6 py-8">
        <HandlePayClaimCard />
      </div>
    </main>
  )
}
