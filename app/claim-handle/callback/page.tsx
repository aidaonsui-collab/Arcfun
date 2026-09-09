'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle } from 'lucide-react'

/**
 * X OAuth2 redirect target for HandlePay claims.
 */
export default function HandlePayCallbackPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const err = params.get('error')

    if (err) {
      setError(params.get('error_description') || err)
      return
    }
    if (!code || !state) {
      setError('Missing code/state from X — return to the claim page and try again.')
      return
    }

    void (async () => {
      try {
        const res = await fetch('/api/handle-pay/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, state }),
        })
        const data = (await res.json()) as {
          error?: string
          giftId?: string
          verifyToken?: string
          username?: string
        }
        if (!res.ok) throw new Error(data.error || 'Verification failed')

        const giftId = String(data.giftId || '')
        try {
          sessionStorage.setItem(
            `handlepay:verify:${giftId}`,
            JSON.stringify({ verifyToken: data.verifyToken, username: data.username, ts: Date.now() }),
          )
        } catch {
          /* sessionStorage disabled */
        }

        const handle = giftId.startsWith('handlepay:') ? giftId.slice('handlepay:'.length) : ''
        router.replace(handle ? `/claim-handle?h=${encodeURIComponent(handle)}` : '/claim-handle')
      } catch (e) {
        setError((e as Error).message || 'Could not verify with X')
      }
    })()
  }, [router])

  return (
    <main className="min-h-screen text-white flex items-center justify-center px-4 pt-16">
      <div className="max-w-md w-full rounded-[22px] border border-hair bg-s1 p-6 text-center space-y-3">
        {error ? (
          <>
            <div className="w-11 h-11 mx-auto rounded-full bg-coral/15 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-coral" />
            </div>
            <p className="m-0 text-sm text-coral">{error}</p>
            <p className="m-0 text-xs text-t3">
              Close this tab and click Verify with X again on the claim page.
            </p>
          </>
        ) : (
          <>
            <Loader2 className="w-6 h-6 text-lime-t animate-spin mx-auto" />
            <p className="m-0 text-sm text-t2">Finishing X verification…</p>
          </>
        )}
      </div>
    </main>
  )
}
