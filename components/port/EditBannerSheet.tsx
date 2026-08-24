'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { collectionMetaEditMessage } from '@/lib/arc-auth'
import { uploadImageToCloudinary } from '@/lib/cloudinary'
import { ImageUpload } from '@/components/port/ImageUpload'
import type { Collection } from '@/lib/port/types'

export function EditBannerSheet({
  collection,
  currentBanner,
  open,
  onClose,
  onSaved,
}: {
  collection: string | Collection
  currentBanner?: string
  open: boolean
  onClose: () => void
  onSaved: (patch: {
    bannerUrl: string
    description?: string
    twitter?: string
    telegram?: string
    website?: string
  }) => void
}) {
  const addr = typeof collection === 'string' ? collection : collection.address
  const col = typeof collection === 'string' ? null : collection
  const { signMessageAsync } = useSignMessage()
  const [preview, setPreview] = useState(currentBanner || col?.banner || '')
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState(col?.description || '')
  const [twitter, setTwitter] = useState(col?.twitter || '')
  const [telegram, setTelegram] = useState(col?.telegram || '')
  const [website, setWebsite] = useState(col?.website || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    setPreview(currentBanner || col?.banner || '')
    setFile(null)
    setDescription(col?.description || '')
    setTwitter(col?.twitter || '')
    setTelegram(col?.telegram || '')
    setWebsite(col?.website || '')
    setErr('')
  }, [open, addr, currentBanner])

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
      const message = collectionMetaEditMessage(addr, timestamp)
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/port/${addr}/meta`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: addr,
          signature,
          timestamp,
          bannerUrl,
          description,
          twitter,
          telegram,
          website,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; bannerUrl?: string }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
      onSaved({
        bannerUrl: data.bannerUrl || bannerUrl || '',
        description,
        twitter,
        telegram,
        website,
      })
    } catch (e) {
      setErr((e as Error).message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none placeholder:text-white/25'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button type="button" className="absolute inset-0 bg-[rgba(10,15,24,0.72)]" aria-label="Close" onClick={onClose} />
      <div className="relative z-10 max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[28px] border border-hair bg-s1 p-5 shadow-2xl sm:rounded-[24px] sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Collection page</h2>
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
        <label className="mt-4 block text-[13px] text-t3">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 280))}
          className={`${inputClass} h-auto min-h-[88px] resize-none py-3`}
        />
        <label className="mt-3 block text-[13px] text-t3">X / Twitter</label>
        <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle" className={inputClass} />
        <label className="mt-3 block text-[13px] text-t3">Telegram</label>
        <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/…" className={inputClass} />
        <label className="mt-3 block text-[13px] text-t3">Website</label>
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={inputClass} />
        {err ? <p className="mt-3 text-[13px] text-coral">{err}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-xl bg-lime text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
        >
          {busy ? 'Signing & saving…' : 'Save'}
        </button>
        <p className="mt-2 text-center text-[11px] text-t3">Sign a message to prove you own this collection. No gas.</p>
      </div>
    </div>
  )
}
