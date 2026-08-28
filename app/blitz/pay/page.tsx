'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { BlitzPayDesk } from '@/components/BlitzPayDesk'

function Inner() {
  const tweet = (useSearchParams().get('tweet') || '').trim()
  if (!tweet) {
    return <p className="text-t2">Missing tweet id. Open the pay link from the bot reply.</p>
  }
  return <BlitzPayDesk tweetId={tweet} />
}

export default function BlitzPayPage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <Suspense fallback={<p className="text-t2">Loading…</p>}>
          <Inner />
        </Suspense>
      </div>
    </main>
  )
}
