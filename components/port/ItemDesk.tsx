'use client'

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { useAccount, useConnect, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useSignMessage } from 'wagmi'
import { FolderUp, Loader2, Upload } from 'lucide-react'
import type { Collection } from '@/lib/port/types'
import type { PortItemMeta } from '@/lib/port/item-meta'
import { cleanTraits, studioItemBaseUri } from '@/lib/port/item-meta'
import { collectionItemsEditMessage } from '@/lib/arc-auth'
import { uploadImageToCloudinary } from '@/lib/cloudinary'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { cn } from '@/lib/cn'
import type { Address } from 'viem'

const PAGE = 48
const CHUNK = 25
const POOL = 4
const AUTH_MS = 8 * 60 * 1000

export function ItemDesk({ collection }: { collection: Collection }) {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { signMessageAsync } = useSignMessage()
  const { writeContract, data: tx, isPending: revealing, error: revealErr } = useWriteContract()
  const { isLoading: revealingWait, isSuccess: revealedOk } = useWaitForTransactionReceipt({ hash: tx })
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const traitsRef = useRef<HTMLInputElement>(null)

  const mine = Boolean(address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase())
  const [items, setItems] = useState<Record<string, PortItemMeta>>({})
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: '' as '' | 'upload' | 'save' })
  const [onChainRevealed, setOnChainRevealed] = useState(false)

  const itemsRef = useRef(items)
  itemsRef.current = items
  const authRef = useRef<{ signature: string; timestamp: number } | null>(null)

  const filled = Object.keys(items).length
  const left = Math.max(0, collection.maxSupply - filled)
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

  async function ensureAuth() {
    const now = Date.now()
    if (authRef.current && now - authRef.current.timestamp < AUTH_MS) return authRef.current
    if (!address) throw new Error('Connect first')
    const timestamp = Date.now()
    const message = collectionItemsEditMessage(collection.address, timestamp)
    const signature = await signMessageAsync({ message })
    authRef.current = { signature, timestamp }
    return authRef.current
  }

  async function save(patch: Record<string, PortItemMeta | null>) {
    const auth = await ensureAuth()
    const res = await fetch(`/api/port/${collection.address}/items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: collection.address,
        signature: auth.signature,
        timestamp: auth.timestamp,
        items: patch,
      }),
    })
    const data = await res.json()
    if (res.status === 401) {
      authRef.current = null
      const retry = await ensureAuth()
      const res2 = await fetch(`/api/port/${collection.address}/items`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: collection.address,
          signature: retry.signature,
          timestamp: retry.timestamp,
          items: patch,
        }),
      })
      const data2 = await res2.json()
      if (!res2.ok || !data2.ok) throw new Error(data2.error || 'Save failed')
      setItems(data2.items || {})
      return
    }
    if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
    setItems(data.items || {})
  }

  async function runBatch(files: File[]) {
    if (!files.length) return
    setErr('')
    setBusy(true)
    setProgress({ done: 0, total: 0, phase: 'upload' })
    try {
      const images = files.filter(isImageFile)
      const jsonFile = files.find((f) => /\.json$/i.test(f.name) && !isImageFile(f))
      const assigned = assignSlots(images, itemsRef.current, collection.maxSupply)
      if (assigned.length === 0 && !jsonFile) throw new Error('No images to add')

      if (assigned.length) {
        setProgress({ done: 0, total: assigned.length, phase: 'upload' })
        const uploaded = await mapPool(assigned, POOL, async ({ file, id }) => {
          const imageUrl = await uploadImageToCloudinary(file, 'port-items')
          setProgress((p) => ({ ...p, done: p.done + 1 }))
          const meta: PortItemMeta = { imageUrl, name: `${collection.name} #${id}` }
          return { id, meta }
        })
        setProgress((p) => ({ ...p, phase: 'save' }))
        for (let i = 0; i < uploaded.length; i += CHUNK) {
          const slice = uploaded.slice(i, i + CHUNK)
          const patch: Record<string, PortItemMeta> = {}
          for (const row of slice) patch[String(row.id)] = row.meta
          await save(patch)
        }
        const first = Math.min(...uploaded.map((r) => r.id))
        setPage(Math.floor((first - 1) / PAGE))
      }

      if (jsonFile) await applyTraitsJson(await jsonFile.text())
    } catch (e) {
      setErr((e as Error).message || 'Upload failed')
    } finally {
      setBusy(false)
      setProgress({ done: 0, total: 0, phase: '' })
      if (fileRef.current) fileRef.current.value = ''
      if (folderRef.current) folderRef.current.value = ''
    }
  }

  async function applyTraitsJson(text: string) {
    const raw = JSON.parse(text) as unknown
    const map = parseTraitPayload(raw)
    const patch: Record<string, PortItemMeta> = {}
    for (const [id, traits] of Object.entries(map)) {
      const existing = itemsRef.current[id]
      if (!existing?.imageUrl) continue
      patch[id] = { ...existing, traits }
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('No matching items. Upload images first, then import metadata JSON.')
    }
    await save(patch)
  }

  async function onTraitsJson(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setErr('')
    setBusy(true)
    try {
      await applyTraitsJson(await file.text())
    } catch (e) {
      setErr((e as Error).message || 'Traits import failed')
    } finally {
      setBusy(false)
      if (traitsRef.current) traitsRef.current.value = ''
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    if (busy) return
    const files = await filesFromDataTransfer(e.dataTransfer)
    await runBatch(files)
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

  const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

  return (
    <div className="mx-auto w-full max-w-desk px-4 pb-24 pt-8 sm:px-10">
      <Link href={`/studio/${collection.address}`} className="text-[13px] font-semibold text-t3 hover:text-white">
        ← {collection.name}
      </Link>
      <h1 className="mt-3 text-[28px] font-semibold tracking-display sm:text-[32px]">Items</h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-t2">
        Add a batch in mint order. Name files 1.png, 2.png, … to lock each image to that ID.
        Drop a folder, or import a metadata JSON after the art is in. Reveal when the set is ready.
      </p>
      <p className="mt-2 text-[13px] text-t3">
        {filled} / {collection.maxSupply} uploaded
        {left ? ` · ${left} left` : ''}
        {onChainRevealed ? ' · revealed on-chain' : ''}
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
        className={cn(
          'mt-6 rounded-[24px] border border-dashed px-5 py-8 text-center transition-colors',
          over ? 'border-lime-line bg-s2' : 'border-hair bg-s1',
          busy && 'opacity-70',
        )}
      >
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-hair bg-s2">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin text-lime-t" />
          ) : (
            <Upload className="h-5 w-5 text-t2" strokeWidth={1.8} />
          )}
        </div>
        <p className="mt-4 text-[15px]">
          {busy ? (
            <span className="font-semibold">
              {progress.phase === 'save'
                ? 'Saving batch…'
                : `Uploading ${progress.done} / ${progress.total}`}
            </span>
          ) : (
            <>
              <span className="font-semibold text-lime-t">Drop a folder or images</span>
              <span className="text-t2"> · PNG, JPG, WEBP</span>
            </>
          )}
        </p>
        {busy && progress.total ? (
          <div className="mx-auto mt-4 h-1 max-w-xs overflow-hidden rounded-full bg-s3">
            <div className="h-full bg-lime transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-t3">Up to {collection.maxSupply} files. Extra files are skipped.</p>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-lime px-4 text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
          >
            Add batch
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => folderRef.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
          >
            <FolderUp className="h-4 w-4" />
            Add folder
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={revealing || revealingWait || filled === 0}
          onClick={() => reveal()}
          className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
        >
          {revealing || revealingWait ? 'Revealing…' : 'Reveal on-chain'}
        </button>
        <button
          type="button"
          disabled={busy || filled === 0}
          onClick={() => traitsRef.current?.click()}
          className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
        >
          Import traits JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => void runBatch(Array.from(e.target.files || []))}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void runBatch(Array.from(e.target.files || []))}
          {...{ webkitdirectory: '', directory: '' }}
        />
        <input
          ref={traitsRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void onTraitsJson(e.target.files)}
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

function isImageFile(file: File) {
  if (file.type.startsWith('image/')) return /png|jpe?g|webp|gif/i.test(file.type)
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name)
}

function fileTokenId(name: string): number | null {
  const base = name.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
  const m = base.match(/(?:^|[^\d])0*(\d+)$/) || base.match(/^0*(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 1 ? n : null
}

function assignSlots(
  files: File[],
  occupied: Record<string, PortItemMeta>,
  maxSupply: number,
): { file: File; id: number }[] {
  const images = [...files].filter(isImageFile).sort((a, b) => {
    const ia = fileTokenId(a.name)
    const ib = fileTokenId(b.name)
    if (ia != null && ib != null && ia !== ib) return ia - ib
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  const parsed = images.map((file) => ({ file, id: fileTokenId(file.name) }))
  const numbered = parsed.every((p) => p.id != null && p.id >= 1 && p.id <= maxSupply)
  const unique = numbered && new Set(parsed.map((p) => p.id)).size === parsed.length
  if (unique) return parsed.map((p) => ({ file: p.file, id: p.id as number }))
  let cursor = 1
  const out: { file: File; id: number }[] = []
  for (const file of images) {
    while (occupied[String(cursor)] && cursor <= maxSupply) cursor += 1
    if (cursor > maxSupply) break
    out.push({ file, id: cursor })
    cursor += 1
  }
  return out
}

async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

type FsEntry = {
  isFile: boolean
  isDirectory: boolean
  file?: (ok: (f: File) => void, err?: (e: Error) => void) => void
  createReader?: () => {
    readEntries: (ok: (entries: FsEntry[]) => void, err?: (e: Error) => void) => void
  }
}

async function filesFromEntry(entry: FsEntry): Promise<File[]> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject)
    })
    return [file]
  }
  if (!entry.isDirectory || !entry.createReader) return []
  const reader = entry.createReader()
  const entries: FsEntry[] = []
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (!batch.length) break
    entries.push(...batch)
  }
  const nested = await Promise.all(entries.map(filesFromEntry))
  return nested.flat()
}

async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items]
  const fromEntries: File[] = []
  let usedEntries = false
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.()
    if (!entry) continue
    usedEntries = true
    fromEntries.push(...(await filesFromEntry(entry)))
  }
  if (usedEntries && fromEntries.length) return fromEntries
  return [...dt.files]
}

function parseTraitPayload(raw: unknown): Record<string, { type: string; value: string }[]> {
  const out: Record<string, { type: string; value: string }[]> = {}
  const add = (id: number, attrs: unknown) => {
    if (!Number.isInteger(id) || id < 1) return
    const traits = cleanTraits(attrs)
    if (traits) out[String(id)] = traits
  }
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const rec = (row || {}) as Record<string, unknown>
      add(Number(rec.id ?? rec.tokenId ?? rec.edition), rec.attributes || rec.traits)
    }
    return out
  }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  const nested = obj.items || obj.tokens || obj.nfts
  if (Array.isArray(nested)) return parseTraitPayload(nested)
  if (nested && typeof nested === 'object') return parseTraitPayload(nested)
  for (const [key, value] of Object.entries(obj)) {
    const id = Number(key)
    if (!Number.isInteger(id)) continue
    if (Array.isArray(value)) {
      add(id, value)
      continue
    }
    const rec = (value || {}) as Record<string, unknown>
    add(id, rec.attributes || rec.traits)
  }
  return out
}
