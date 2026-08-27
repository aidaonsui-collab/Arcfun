'use client'

/**
 * /portfolio folded into Profile. Keep the URL so old links still land.
 */
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect } from 'wagmi'

export default function PortfolioPage() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()

  useEffect(() => {
    if (isConnected && address) {
      router.replace(`/creator/${address}`)
    }
  }, [isConnected, address, router])

  if (isConnected && address) {
    return (
      <main className="min-h-screen text-white pt-16 flex items-center justify-center">
        <p className="text-t3 text-sm">Opening your profile…</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-16 flex flex-col items-center gap-4">
        <h1 className="m-0 text-[28px] font-semibold tracking-tightish">Profile</h1>
        <p className="m-0 text-t2 text-sm text-center max-w-md">
          Connect your wallet to open coins you launched, creator LP fees, and Instant Reflection
          rewards. Same page as Profile in the header.
        </p>
        <button
          type="button"
          disabled={connecting}
          onClick={() => connectors[0] && connect({ connector: connectors[0] })}
          className="h-11 px-6 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
      </div>
    </main>
  )
}
