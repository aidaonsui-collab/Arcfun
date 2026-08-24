import { kv } from '@vercel/kv'

const KEY = (a: string) => `arcfun:port:items:${a.toLowerCase()}`

export type PortItemMeta = {
  imageUrl: string
  name?: string
  description?: string
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
    else items[id] = meta
  }
  const next: PortItemsStore = { items, updatedAt: Date.now() }
  await kv.set(KEY(address), next)
  return next
}

export function studioItemBaseUri(collection: string): string {
  const site = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.arcfun.co').replace(/\/$/, '')
  return `${site}/api/port/${collection.toLowerCase()}/uri/`
}
