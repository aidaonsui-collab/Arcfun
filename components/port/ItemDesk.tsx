'use client'

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { useAccount, useConnect, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useSignMessage } from 'wagmi'
import { FolderUp, Loader2, Pencil, Upload } from 'lucide-react'
import type { Collection, Trait } from '@/lib/port/types'
import { studioPath } from '@/lib/port/path'
import type { PortItemMeta } from '@/lib/port/item-meta'
import {
  cleanTraits,
  parseMetadataCsv,
  rarityOf,
  RARITY_TIERS,
  studioItemBaseUri,
  withRarity,
} from '@/lib/port/item-meta'
import { PortSheet } from '@/components/port/PortSheet'
import { getAddress, type Address } from 'viem'
import { authQuery, prepareCollectionAuth } from '@/lib/arc-auth'
import { uploadImage } from '@/lib/upload-image'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { cn } from '@/lib/cn'

const PAGE = 48
const POOL = 4


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
  const [onChainRevealed, setOnChainRevealed] = useState(Boolean(collection.revealed))
  const [editing, setEditing] = useState<number | null>(null)
  const [viewId, setViewId] = useState<number | null>(null)
  const [rarityFilter, setRarityFilter] = useState('')

  const itemsRef = useRef(items)
  itemsRef.current = items

  const filled = Object.keys(items).length
  const left = Math.max(0, collection.maxSupply - filled)
  const pages = Math.max(1, Math.ceil(collection.maxSupply / PAGE))
  const start = page * PAGE
  const slots = useMemo(
    () => Array.from({ length: Math.min(PAGE, collection.maxSupply - start) }, (_, i) => start + i + 1),
    [start, collection.maxSupply],
  )

  useEffect(() => {
    if (!mine) return
    let cancelled = false
    ;(async () => {
      try {
        let url = `/api/port/${collection.address}/items`
        if (!collection.revealed) {
          const payload = { collection: getAddress(collection.address) }
          const prepared = prepareCollectionAuth(collection.address, 'read-items', payload)
          const signature = await signMessageAsync({ message: prepared.message })
          url += `?${authQuery({ signature, timestamp: prepared.timestamp, nonce: prepared.nonce })}`
        }
        const d = await fetch(url).then((r) => r.json())
        if (!cancelled && d?.items) setItems(d.items)
      } catch {
        /* keep empty */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mine, collection.address, collection.revealed, signMessageAsync])

  async function save(patch: Record<string, PortItemMeta | null>) {
    const payload = { collection: getAddress(collection.address), items: patch }
    const prepared = prepareCollectionAuth(collection.address, 'update-items', payload)
    const signature = await signMessageAsync({ message: prepared.message })
    const res = await fetch(`/api/port/${collection.address}/items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: collection.address,
        signature,
        timestamp: prepared.timestamp,
        nonce: prepared.nonce,
        items: patch,
      }),
    })
    const data = await res.json()
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
      const metaFile = files.find(
        (f) => !isImageFile(f) && (/\.json$/i.test(f.name) || /\.csv$/i.test(f.name)),
      )
      const assigned = assignSlots(images, itemsRef.current, collection.maxSupply)
      if (assigned.length === 0 && !metaFile) throw new Error('No images to add')

      if (assigned.length) {
        setProgress({ done: 0, total: assigned.length, phase: 'upload' })
        const uploaded = await mapPool(assigned, POOL, async ({ file, id }) => {
          const imageUrl = await uploadImage(file, 'port-items')
          setProgress((p) => ({ ...p, done: p.done + 1 }))
          const meta: PortItemMeta = { imageUrl, name: nameFromFile(file.name, `${collection.name} #${id}`) }
          return { id, meta }
        })
        setProgress((p) => ({ ...p, phase: 'save' }))
        const patch: Record<string, PortItemMeta> = {}
        for (const row of uploaded) patch[String(row.id)] = row.meta
        await save(patch)
        const first = Math.min(...uploaded.map((r) => r.id))
        setPage(Math.floor((first - 1) / PAGE))
      }

      if (metaFile) await applyMetaText(await metaFile.text(), metaFile.name)
    } catch (e) {
      setErr((e as Error).message || 'Upload failed')
    } finally {
      setBusy(false)
      setProgress({ done: 0, total: 0, phase: '' })
      if (fileRef.current) fileRef.current.value = ''
      if (folderRef.current) folderRef.current.value = ''
    }
  }

  async function applyMetaText(text: string, filename = '') {
    let map: Record<string, MetaPatch>
    const looksCsv = /\.csv$/i.test(filename) || /^tokenid[,;\t]/i.test(text.trim())
    if (looksCsv) map = parseMetadataCsv(text)
    else {
      try {
        map = parseMetaPayload(JSON.parse(text) as unknown)
      } catch {
        map = parseMetadataCsv(text)
      }
    }
    const patch: Record<string, PortItemMeta> = {}
    for (const [id, row] of Object.entries(map)) {
      const existing = itemsRef.current[id]
      if (!existing?.imageUrl) continue
      patch[id] = {
        ...existing,
        ...(row.name ? { name: row.name } : {}),
        ...(row.description ? { description: row.description } : {}),
        ...(row.traits ? { traits: row.traits } : {}),
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('No matching items. Upload images first, then import metadata CSV or JSON.')
    }
    await save(patch)
  }

  async function saveItemEdit(id: number, patch: { name: string; description: string; rarity: string; extra: Trait[] }) {
    const existing = itemsRef.current[String(id)]
    if (!existing?.imageUrl) return
    const traits = withRarity(
      patch.extra.filter((t) => t.type.trim() && t.value.trim()),
      patch.rarity,
    )
    setErr('')
    setBusy(true)
    try {
      await save({
        [String(id)]: {
          ...existing,
          name: patch.name.trim().slice(0, 64) || `${collection.name} #${id}`,
          description: patch.description.trim().slice(0, 280),
          traits,
        },
      })
      setViewId(null)
    } catch (e) {
      setErr((e as Error).message || 'Could not save item')
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    const ids = Object.keys(items)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
    const traitTypes = new Set<string>()
    for (const id of ids) {
      for (const t of items[String(id)]?.traits || []) {
        if (t.type) traitTypes.add(t.type)
      }
    }
    const types = ['Rarity', ...[...traitTypes].filter((t) => t.toLowerCase() !== 'rarity').sort()]
    const esc = (v: string) => {
      if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
      return v
    }
    const header = ['tokenID', 'name', 'description', ...types]
    const rows = [header.join(',')]
    for (const id of ids) {
      const it = items[String(id)]
      if (!it) continue
      const map = new Map((it.traits || []).map((t) => [t.type, t.value]))
      rows.push(
        [
          String(id),
          esc(it.name || ''),
          esc(it.description || ''),
          ...types.map((t) => esc(map.get(t) || '')),
        ].join(','),
      )
    }
    const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${collection.symbol || 'collection'}-metadata.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function saveName(id: number, raw: string) {
    const existing = itemsRef.current[String(id)]
    if (!existing?.imageUrl) {
      setEditing(null)
      return
    }
    const name = raw.trim().slice(0, 64)
    const fallback = `${collection.name} #${id}`
    const next = name || fallback
    if ((existing.name || fallback) === next) {
      setEditing(null)
      return
    }
    setErr('')
    setBusy(true)
    try {
      await save({ [String(id)]: { ...existing, name: next } })
    } catch (e) {
      setErr((e as Error).message || 'Could not save name')
    } finally {
      setBusy(false)
      setEditing(null)
    }
  }

  async function onTraitsJson(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setErr('')
    setBusy(true)
    try {
      await applyMetaText(await file.text(), file.name)
    } catch (e) {
      setErr((e as Error).message || 'Metadata import failed')
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
      <div className="flex flex-wrap items-center gap-3">
        <Link href={studioPath(collection)} className="text-[13px] font-semibold text-t3 hover:text-white">
          ← {collection.name}
        </Link>
        <Link href={studioPath(collection, 'airdrop')} className="text-[13px] font-semibold text-t3 hover:text-white">
          Airdrop
        </Link>
      </div>
      <h1 className="mt-3 text-[28px] font-semibold tracking-display sm:text-[32px]">Items</h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-t2">
        Add a batch in mint order. Name files 1.png, 2.png, … to lock each image to that ID.
        Click an item to edit name, description, rarity, and traits. Import a CSV or JSON for the
        whole set. Reveal when it is ready.
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
          disabled={busy || filled === 0 || onChainRevealed}
          onClick={() => traitsRef.current?.click()}
          className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
        >
          Import CSV / JSON
        </button>
        <button
          type="button"
          disabled={filled === 0}
          onClick={exportCsv}
          className="inline-flex h-11 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
        >
          Export CSV
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
          accept="application/json,.json,text/csv,.csv"
          className="hidden"
          onChange={(e) => void onTraitsJson(e.target.files)}
        />
      </div>
      {onChainRevealed ? (
        <p className="mt-3 text-[13px] text-t3">Revealed on-chain. Metadata is locked, same as an OpenSea drop.</p>
      ) : null}
      {err || revealErr ? (
        <p className="mt-3 text-[13px] text-coral">{err || (revealErr as Error).message}</p>
      ) : null}

      {filled > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {['', ...RARITY_TIERS].map((tier) => (
            <button
              key={tier || 'all'}
              type="button"
              onClick={() => setRarityFilter(tier)}
              className={cn(
                'h-8 rounded-full border px-3 text-[12px] font-semibold',
                rarityFilter === tier
                  ? 'border-lime-line bg-s2 text-white'
                  : 'border-hair text-t3 hover:text-white',
              )}
            >
              {tier || 'All'}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-8 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {(rarityFilter
          ? slots.filter((id) => rarityOf(items[String(id)]?.traits) === rarityFilter)
          : slots
        ).map((id) => {
          const meta = items[String(id)]
          const tier = rarityOf(meta?.traits)
          return (
            <div key={id} className="overflow-hidden rounded-2xl border border-hair bg-s1">
              <button
                type="button"
                disabled={!meta}
                onClick={() => meta && setViewId(id)}
                className="block w-full disabled:cursor-default"
                title={meta ? 'View / Edit' : undefined}
              >
                <div className="relative aspect-square bg-s2">
                  {meta?.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={meta.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full place-items-center text-[12px] text-t3">#{id}</div>
                  )}
                  {meta ? (
                    <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[rgba(10,15,24,0.72)] text-white">
                      <Pencil className="h-3 w-3" />
                    </span>
                  ) : null}
                </div>
              </button>
              <div className="px-1.5 py-1.5">
                {editing === id && meta ? (
                  <input
                    autoFocus
                    defaultValue={
                      meta.name && meta.name !== `${collection.name} #${id}` ? meta.name : ''
                    }
                    placeholder={`${collection.name} #${id}`}
                    maxLength={64}
                    disabled={busy}
                    onBlur={(e) => void saveName(id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    className="h-7 w-full rounded-md border border-lime-line bg-s2 px-1.5 text-[11px] outline-none"
                    aria-label={`Name for #${id}`}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={!meta || busy || onChainRevealed}
                    onClick={() => meta && setViewId(id)}
                    title={meta ? 'View / Edit' : undefined}
                    className="block w-full truncate text-left text-[11px] text-t3 disabled:cursor-default"
                  >
                    {meta ? displayName(meta, collection.name, id) : `#${id}`}
                    {tier ? <span className="mt-0.5 block truncate text-[10px] text-white/45">{tier}</span> : null}
                  </button>
                )}
              </div>
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
      <ItemEditSheet
        collectionName={collection.name}
        id={viewId}
        meta={viewId != null ? items[String(viewId)] : undefined}
        locked={onChainRevealed}
        busy={busy}
        onClose={() => setViewId(null)}
        onSave={(patch) => viewId != null && void saveItemEdit(viewId, patch)}
      />
    </div>
  )
}

function ItemEditSheet({
  collectionName,
  id,
  meta,
  locked,
  busy,
  onClose,
  onSave,
}: {
  collectionName: string
  id: number | null
  meta?: PortItemMeta
  locked: boolean
  busy: boolean
  onClose: () => void
  onSave: (patch: { name: string; description: string; rarity: string; extra: Trait[] }) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rarity, setRarity] = useState('')
  const [extra, setExtra] = useState<Trait[]>([])

  useEffect(() => {
    if (id == null || !meta) return
    setName(meta.name && meta.name !== `${collectionName} #${id}` ? meta.name : '')
    setDescription(meta.description || '')
    setRarity(rarityOf(meta.traits))
    setExtra((meta.traits || []).filter((t) => t.type.toLowerCase() !== 'rarity'))
  }, [id, meta, collectionName])

  const inputClass =
    'mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none placeholder:text-white/25'

  return (
    <PortSheet open={id != null && !!meta} onClose={onClose} title={id != null ? `Item #${id}` : 'Item'}>
      {meta ? (
        <div className="pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={meta.imageUrl} alt="" className="mx-auto aspect-square w-40 rounded-2xl object-cover" />
          <label className="mt-4 block text-[13px] text-t3">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 64))}
            placeholder={`${collectionName} #${id}`}
            disabled={locked}
            className={inputClass}
          />
          <label className="mt-3 block text-[13px] text-t3">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 280))}
            disabled={locked}
            className={`${inputClass} h-auto min-h-[88px] resize-none py-3`}
          />
          <label className="mt-3 block text-[13px] text-t3">Rarity</label>
          <select
            value={rarity}
            onChange={(e) => setRarity(e.target.value)}
            disabled={locked}
            className={inputClass}
          >
            <option value="">None</option>
            {RARITY_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[13px] text-t3">Traits</span>
            {locked ? null : (
              <button
                type="button"
                onClick={() => setExtra((rows) => [...rows, { type: '', value: '' }].slice(0, 16))}
                className="text-[13px] font-semibold text-lime-t"
              >
                Add trait
              </button>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {extra.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.type}
                  placeholder="Type"
                  disabled={locked}
                  onChange={(e) =>
                    setExtra((rows) => rows.map((r, j) => (j === i ? { ...r, type: e.target.value.slice(0, 32) } : r)))
                  }
                  className="h-11 w-[42%] rounded-xl border border-hair bg-s2 px-3 text-[14px] outline-none"
                />
                <input
                  value={row.value}
                  placeholder="Value"
                  disabled={locked}
                  onChange={(e) =>
                    setExtra((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value.slice(0, 48) } : r)))
                  }
                  className="h-11 min-w-0 flex-1 rounded-xl border border-hair bg-s2 px-3 text-[14px] outline-none"
                />
                {locked ? null : (
                  <button
                    type="button"
                    onClick={() => setExtra((rows) => rows.filter((_, j) => j !== i))}
                    className="h-11 px-2 text-[13px] text-t3 hover:text-white"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          {locked ? (
            <p className="mt-4 text-[13px] text-t3">Locked after reveal.</p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave({ name, description, rarity, extra })}
              className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-xl bg-lime text-[15px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      ) : null}
    </PortSheet>
  )
}

function isImageFile(file: File) {
  if (file.type.startsWith('image/')) return /png|jpe?g|webp|gif/i.test(file.type)
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name)
}

function displayName(meta: PortItemMeta, collectionName: string, id: number) {
  const fallback = `${collectionName} #${id}`
  const name = (meta.name || '').trim()
  if (!name || name === fallback || name === `#${id}`) return `#${id}`
  return name
}

function nameFromFile(filename: string, fallback: string) {
  const base = filename.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
  const rest = base.replace(/^0*\d+[\s._-]*/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!rest) return fallback
  return rest.slice(0, 64)
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

type MetaPatch = { name?: string; description?: string; traits?: { type: string; value: string }[] }

function parseMetaPayload(raw: unknown): Record<string, MetaPatch> {
  const out: Record<string, MetaPatch> = {}
  const add = (id: number, rec: Record<string, unknown> | unknown[]) => {
    if (!Number.isInteger(id) || id < 1) return
    if (Array.isArray(rec)) {
      const traits = cleanTraits(rec)
      if (traits) out[String(id)] = { ...(out[String(id)] || {}), traits }
      return
    }
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 64) : ''
    const description = typeof rec.description === 'string' ? rec.description.trim().slice(0, 280) : ''
    const traits = cleanTraits(rec.attributes || rec.traits)
    const row: MetaPatch = {}
    if (name) row.name = name
    if (description) row.description = description
    if (traits) row.traits = traits
    if (row.name || row.description || row.traits) out[String(id)] = { ...(out[String(id)] || {}), ...row }
  }
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const rec = (row || {}) as Record<string, unknown>
      add(Number(rec.id ?? rec.tokenId ?? rec.edition), rec)
    }
    return out
  }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  const nested = obj.items || obj.tokens || obj.nfts
  if (Array.isArray(nested)) return parseMetaPayload(nested)
  if (nested && typeof nested === 'object') return parseMetaPayload(nested)
  for (const [key, value] of Object.entries(obj)) {
    const id = Number(key)
    if (!Number.isInteger(id)) continue
    if (Array.isArray(value)) add(id, value)
    else add(id, (value || {}) as Record<string, unknown>)
  }
  return out
}
