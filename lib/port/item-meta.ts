import { kv } from '@vercel/kv'
import type { Trait } from './types'

const KEY = (a: string) => `arcfun:port:items:${a.toLowerCase()}`

export type PortItemMeta = {
  imageUrl: string
  name?: string
  description?: string
  traits?: Trait[]
}

export function cleanTraits(raw: unknown): Trait[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Trait[] = []
  for (const row of raw.slice(0, 16)) {
    const rec = (row || {}) as { type?: unknown; trait_type?: unknown; value?: unknown }
    const type = String(rec.type || rec.trait_type || '')
      .trim()
      .slice(0, 32)
    const value = String(rec.value || '')
      .trim()
      .slice(0, 48)
    if (!type || !value) continue
    out.push({ type, value })
  }
  return out.length ? out : undefined
}

const CSV_SKIP = new Set([
  'tokenid',
  'token_id',
  'token id',
  'id',
  'edition',
  'name',
  'description',
  'desc',
  'file_name',
  'filename',
  'file',
  'image',
  'image_url',
  'imageurl',
  'url',
])

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else quoted = !quoted
    } else if ((c === ',' || c === '\t') && !quoted) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  out.push(cur.trim())
  return out
}

export type ItemMetaPatch = { name?: string; description?: string; traits?: Trait[] }

/** OpenSea-style metadata CSV: tokenID, name, description, then trait columns. */
export function parseMetadataCsv(text: string): Record<string, ItemMetaPatch> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return {}
  const headers = splitCsvLine(lines[0]).map((h) => h.trim())
  const out: Record<string, ItemMetaPatch> = {}
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line)
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => {
      rec[h] = cols[i] ?? ''
    })
    const id = Number(rec.tokenID || rec.tokenId || rec.token_id || rec.id || rec.edition)
    if (!Number.isInteger(id) || id < 1) continue
    const name = (rec.name || '').trim().slice(0, 64)
    const description = (rec.description || rec.desc || '').trim().slice(0, 280)
    const traits: Trait[] = []
    const attrRaw = rec.attributes || rec.traits
    if (attrRaw) {
      try {
        const parsed = cleanTraits(JSON.parse(attrRaw))
        if (parsed) traits.push(...parsed)
      } catch {
        /* not JSON */
      }
    }
    for (const [key, value] of Object.entries(rec)) {
      const k = key.trim()
      if (!k || CSV_SKIP.has(k.toLowerCase()) || k.toLowerCase() === 'attributes' || k.toLowerCase() === 'traits') {
        continue
      }
      const v = value.trim().slice(0, 48)
      if (!v) continue
      traits.push({ type: k.slice(0, 32), value: v })
    }
    const row: ItemMetaPatch = {}
    if (name) row.name = name
    if (description) row.description = description
    const cleaned = cleanTraits(traits)
    if (cleaned) row.traits = cleaned
    if (row.name || row.description || row.traits) out[String(id)] = row
  }
  return out
}

export const RARITY_TIERS = ['Common', 'Uncommon', 'Epic', 'Legendary'] as const

export function rarityOf(traits?: Trait[]): string {
  const hit = (traits || []).find((t) => t.type.toLowerCase() === 'rarity')
  return hit?.value || ''
}

export function withRarity(traits: Trait[] | undefined, rarity: string): Trait[] {
  const rest = (traits || []).filter((t) => t.type.toLowerCase() !== 'rarity')
  const v = rarity.trim()
  if (!v) return rest
  return [...rest, { type: 'Rarity', value: v.slice(0, 48) }]
}

export type PortItemsStore = {
  items: Record<string, PortItemMeta>
  updatedAt: number
}

export async function getPortItems(address: string): Promise<PortItemsStore> {
  try {
    const row = await kv.get<PortItemsStore>(KEY(address))
    if (row?.items) return row
  } catch {
    /* kv optional */
  }
  return { items: {}, updatedAt: 0 }
}

export async function getPortItem(address: string, id: number): Promise<PortItemMeta | null> {
  const store = await getPortItems(address)
  return store.items[String(id)] ?? null
}

export async function mergePortItems(
  address: string,
  patch: Record<string, PortItemMeta | null>,
): Promise<PortItemsStore> {
  const prev = await getPortItems(address)
  const items = { ...prev.items }
  for (const [id, meta] of Object.entries(patch)) {
    if (!meta || !meta.imageUrl) delete items[id]
    else {
      const prevRow = items[id]
      const name =
        typeof meta.name === 'string'
          ? meta.name.trim().slice(0, 64) || undefined
          : prevRow?.name
      const description =
        typeof meta.description === 'string'
          ? meta.description.trim().slice(0, 280) || undefined
          : prevRow?.description
      const nextRow: PortItemMeta = {
        imageUrl: meta.imageUrl,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      }
      if (Array.isArray(meta.traits)) {
        const cleaned = cleanTraits(meta.traits)
        if (cleaned) nextRow.traits = cleaned
      } else if (prevRow?.traits) {
        nextRow.traits = prevRow.traits
      }
      items[id] = nextRow
    }
  }
  const next: PortItemsStore = { items, updatedAt: Date.now() }
  await kv.set(KEY(address), next)
  return next
}

export function studioItemBaseUri(collection: string): string {
  const site = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.arcfun.co').replace(/\/$/, '')
  return `${site}/api/port/${collection.toLowerCase()}/uri/`
}
