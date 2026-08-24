'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount, useConnect, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useSignMessage } from 'wagmi'
import { Loader2, Upload } from 'lucide-react'
import type { Collection } from '@/lib/port/types'
import type { PortItemMeta } from '@/lib/port/item-meta'
import { studioItemBaseUri } from '@/lib/port/item-meta'
import { collectionItemsEditMessage } from '@/lib/arc-auth'
import { uploadImageToCloudinary } from '@/lib/cloudinary'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import type { Address } from 'viem'

const PAGE = 48

export function ItemDesk({ collection }: { collection: Collection }) {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { signMessageAsync } = useSignMessage()
  const { writeContract, data: tx, isPending: revealing, error: revealErr } = useWriteContract()
  const { isLoading: revealingWait, isSuccess: revealedOk } = useWaitForTransactionReceipt({ hash: tx })
  const fileRef = useRef<HTMLInputElement>(null)

  const mine = Boolean(address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase())
  const [items, setItems] = useState<Record<string, PortItemMeta>>({})
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [onChainRevealed, setOnChainRevealed] = useState(false)

  const itemsRef = useRef(items)
  itemsRef.current = items

  const filled = Object.keys(items).length
  const pages = Math.max(1, Math.ceil(collection.maxSupply / PAGE))
  const start = page * PAGE
  const slots = useMemo(
    () => Array.from({ length: Math.min(PAGE, collection.maxSupply - start) }, (_, i) => start + i + 1),
    [start, collection.maxSupply],
  )

  useEffect(() => {
    fetch(`/api/port/${collection.address}/items`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.items) setItems(d.items)
      })
      .catch(() => null)
  }, [collection.address])

  async function save(patch: Record<string, PortItemMeta | null>) {
    if (!address) throw new Error('Connect first')
    const timestamp = Date.now()
    const message = collectionItemsEditMessage(collection.address, timestamp)
    const signature = await signMessageAsync({ message })
    const res = await fetch(`/api/port/${collection.address}/items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: collection.address, signature, timestamp, items: patch }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
    setItems(data.items || {})
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setErr('')
    setBusy(true)
    try {
      let cursor = 1
      const current = itemsRef.current
      while (current[String(cursor)] && cursor <= collection.maxSupply) cursor += 1
      const patch: Record<string, PortItemMeta> = {}
      const list = Array.from(files).slice(0, collection.maxSupply - cursor + 1)
      for (const file of list) {
        if (!file.type.startsWith('image/')) continue
        const imageUrl = await uploadImageToCloudinary(file, 'port-items')
        patch[String(cursor)] = { imageUrl, name: `${collection.name} #${cursor}` }
        cursor += 1
      }
      if (Object.keys(patch).length === 0) throw new Error('No images to add')
      await save(patch)
    } catch (e) {
      setErr((e as Error).message || 'Upload failed')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function reveal() {
    setErr('')
    writeContract({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'reveal',
      args: [studioItemBaseUri(collection.address)],
      chainId: ARC_CHAIN_ID,
    })
  }

  useEffect(() => {
    if (revealedOk) setOnChainRevealed(true)
  }, [revealedOk])

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-[28px] font-semibold tracking-display">Upload items</h1>
        <p className="mt-2 text-[15px] text-t2">Connect the collection owner wallet to add artwork.</p>
        <button
          type="button"
          disabled={isPending}
          onClick={() => connect({ connector: connectors[0] })}
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-lime px-5 text-[14px] font-semibold text-white"
        >
          Connect
        </button>
      </div>
    )
  }

  if (!mine) {
    return (
      <div className="px-4 py-24 text-center text-t2">
        Only the collection creator can upload items.
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-desk px-4 pb-24 pt-8 sm:px-10">
      <Link href={`/studio/${collection.address}`} className="text-[13px] font-semibold text-t3 hover:text-white">
        ← {collection.name}
      </Link>
      <h1 className="mt-3 text-[28px] font-semibold tracking-display sm:text-[32px]">Items</h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-t2">
        Drop art in mint order (#1, #2, …). Collectors mint the next ID. When the set is ready,
        reveal so each minted piece uses its own image instead of the collection placeholder.
      </p>
      <p className="mt-2 text-[13px] text-t3">
        {filled} / {collection.maxSupply} uploaded
        {onChainRevealed ? ' · revealed on-chain' : ''}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-lime px-4 text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {busy ? 'Uploading…' : 'Upload images'}
        </button>
        <button
          type="button"
          disabled={revealing || revealingWait || filled === 0}
          onClick={() => reveal()}
          className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
        >
          {revealing || revealingWait ? 'Revealing…' : 'Reveal on-chain'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>
      {err || revealErr ? (
        <p className="mt-3 text-[13px] text-coral">{err || (revealErr as Error).message}</p>
      ) : null}

      <div className="mt-8 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {slots.map((id) => {
          const meta = items[String(id)]
          return (
            <div key={id} className="overflow-hidden rounded-2xl border border-hair bg-s1">
              <div className="aspect-square bg-s2">
                {meta?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={meta.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full place-items-center text-[12px] text-t3">#{id}</div>
                )}
              </div>
              <div className="px-2 py-1.5 text-[11px] tabular-nums text-t3">#{id}</div>
            </div>
          )
        })}
      </div>
      {pages > 1 ? (
        <div className="mt-6 flex items-center justify-center gap-3 text-[13px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-xl border border-hair px-3 py-1.5 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-t3">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            className="rounded-xl border border-hair px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  )
}
