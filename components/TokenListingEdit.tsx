'use client'

/**
 * Creator-only save for off-chain pfp / socials. Same signed POST /api/arc/register
 * the create form uses. Identity (name/symbol) is already on-chain; this is the
 * second prompt that often gets closed after mint.
 */
import { useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import { useAccount, useSignMessage } from 'wagmi'
import { Loader2 } from 'lucide-react'
import { prepareTokenRegisterAuth } from '@/lib/arc-auth'
import { uploadImage } from '@/lib/upload-image'
import type { PoolToken } from '@/lib/tokens'

export function TokenListingEdit({
  token,
  pool,
  onSaved,
}: {
  token: Address
  pool: PoolToken
  onSaved: (patch: Partial<PoolToken>) => void
}) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const creator = pool.creator
  const isCreator =
    !!address &&
    !!creator &&
    isAddress(address) &&
    isAddress(creator) &&
    getAddress(address) === getAddress(creator as Address)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState(pool.imageUrl || pool.logoUrl || '')
  const [twitter, setTwitter] = useState(pool.twitter || '')
  const [telegram, setTelegram] = useState(pool.telegram || '')
  const [website, setWebsite] = useState(pool.website || '')
  const [description, setDescription] = useState(pool.description || '')

  if (!isCreator) return null

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      let imageUrl = pool.imageUrl || pool.logoUrl || ''
      if (file) imageUrl = await uploadImage(file, 'arcfun')
      const payload = {
        token: getAddress(token),
        name: (pool.name || '').trim(),
        symbol: (pool.symbol || '').trim(),
        description: description.trim(),
        imageUrl,
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        website: website.trim(),
        streamUrl: '',
        pool: pool.instantMeta?.uniPool || '',
      }
      const prepared = prepareTokenRegisterAuth(token, payload)
      const signature = await signMessageAsync({ message: prepared.message })
      const res = await fetch('/api/arc/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          signature,
          timestamp: prepared.timestamp,
          nonce: prepared.nonce,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(j?.error || `save failed (${res.status})`)
      }
      onSaved({
        imageUrl,
        logoUrl: imageUrl,
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        website: website.trim(),
        description: description.trim(),
      })
      setOpen(false)
    } catch (e) {
      setErr((e as Error).message || 'save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-2.5 py-1 rounded-[9px] bg-s2 border border-hair text-xs font-medium text-lime-t hover:border-lime-line transition-colors"
      >
        {open ? 'Close' : 'Edit listing'}
      </button>
      {open ? (
        <div className="mt-3 w-full max-w-md rounded-[16px] border border-hair bg-s2 p-4 flex flex-col gap-3">
          <p className="m-0 text-[12px] text-t3 leading-snug">
            Image and links are off-chain. Sign once with the launch wallet to stamp them.
          </p>
          <label className="text-[12px] font-medium text-t2">
            Pfp
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="mt-1 block w-full text-[12px] text-t2"
              onChange={(e) => {
                const next = e.target.files?.[0] || null
                setFile(next)
                if (next) setPreview(URL.createObjectURL(next))
              }}
            />
          </label>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="w-16 h-16 rounded-[12px] object-cover" />
          ) : null}
          <label className="text-[12px] font-medium text-t2">
            X
            <input
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              placeholder="@handle"
              className="mt-1 w-full h-9 px-3 rounded-[10px] bg-s1 border border-hair text-[13px] text-white"
            />
          </label>
          <label className="text-[12px] font-medium text-t2">
            Telegram
            <input
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              placeholder="@channel"
              className="mt-1 w-full h-9 px-3 rounded-[10px] bg-s1 border border-hair text-[13px] text-white"
            />
          </label>
          <label className="text-[12px] font-medium text-t2">
            Website
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://"
              className="mt-1 w-full h-9 px-3 rounded-[10px] bg-s1 border border-hair text-[13px] text-white"
            />
          </label>
          <label className="text-[12px] font-medium text-t2">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={280}
              className="mt-1 w-full px-3 py-2 rounded-[10px] bg-s1 border border-hair text-[13px] text-white resize-none"
            />
          </label>
          {err ? <p className="m-0 text-[12px] text-coral">{err}</p> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="h-9 px-4 rounded-[10px] text-white text-[13px] font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            style={{ background: 'var(--lime)' }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {busy ? 'Saving…' : 'Sign and save'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
