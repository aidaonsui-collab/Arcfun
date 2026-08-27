import type { Metadata } from 'next'
import { BlitzDesk } from '@/components/BlitzDesk'

export const metadata: Metadata = {
  title: 'Blitz launch — Arcfun',
  description: 'Turn an X post into an Instant TOKEN/USDC launch on Arc. You confirm the mint.',
}

export default function BlitzPage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <BlitzDesk />
      </div>
    </main>
  )
}
