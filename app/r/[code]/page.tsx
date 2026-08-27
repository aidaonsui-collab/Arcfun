/**
 * Referral landing — persist opaque code, then send the visitor home. Never 404.
 */
'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { persistReferralCode } from '@/lib/crucible'

export default function ReferralCodePage() {
  const params = useParams()
  const router = useRouter()

  useEffect(() => {
    const raw = String(params?.code ?? '')
    persistReferralCode(raw)
    router.replace('/')
  }, [params, router])

  return (
    <main className="min-h-screen text-white pt-16 flex items-center justify-center px-4">
      <p className="m-0 text-sm text-t2">Saving referral…</p>
    </main>
  )
}
