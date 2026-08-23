'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { collectionBannerEditMessage } from '@/lib/arc-auth'
import { uploadImageToCloudinary } from '@/lib/cloudinary'
import { ImageUpload } from '@/components/port/ImageUpload'

export function EditBannerSheet({
  collection,
  currentBanner,
  open,
  onClose,
  onSaved,
}: {
  collection: string
  currentBanner: string
  open: boolean
  onClose: () => void
  onSaved: (bannerUrl: string) => void
}) {
  const { signMessageAsync } = useSignMessage()
  const [preview, setPreview] = useState(currentBanner)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    setPreview(currentBanner)
    setFile(null)
    setErr('')
  }, [open, currentBanner])

  if (!open) return null

  async function save() {
    setErr('')
    setBusy(true)
    try {
      let bannerUrl = preview
      if (file) {
        bannerUrl = await uploadImageToCloudinary(file, 'port')
      }
      if (preview === '' && !file) bannerUrl = ''
      const timestamp = Date.now()
      const message = collectionBannerEditMessage(collection, timestamp)
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/port/${collection}/meta`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: collection, signature, timestamp, bannerUrl }),
      })
      const data = (await res.json()) as { ok?: boolean; bannerUrl?: string; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
      onSaved(data.bannerUrl || '')
    } catch (e) {
      setErr((e as Error).message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(10,15,24,0.72)]"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-t-[28px] border border-hair bg-s1 p-5 shadow-2xl sm:rounded-[24px] sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Collection banner</h2>
          <button type="button" onClick={onClose} className="text-[13px] text-t3 hover:text-white">
            Close
          </button>
        </div>
        <ImageUpload
          variant="banner"
          label="Banner"
          hint="1500 × 500 · JPG, PNG, WEBP"
          value={preview}
          onChange={(src, next) => {
            setPreview(src)
            setFile(next ?? null)
          }}
          onClear={() => {
            setPreview('')
            setFile(null)
          }}
        />
        {err ? <p className="mt-3 text-[13px] text-coral">{err}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-xl bg-lime text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
        >
          {busy ? 'Signing & saving…' : 'Save banner'}
        </button>
        <p className="mt-2 text-center text-[11px] text-t3">
          Sign a message to prove you own this collection. No gas.
        </p>
      </div>
    </div>
  )
}
