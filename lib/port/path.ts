import type { Collection } from './types'

const RESERVED = new Set(['create', 'me', 'u', 'items', 'airdrop', 'search', 'api'])

export function slugifyCollectionName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

export type CollectionPath = Pick<Collection, 'address' | 'name'> & {
  slug?: string
  symbol?: string
}

export function collectionSlug(c: CollectionPath): string {
  const fromName = slugifyCollectionName(c.name)
  const fromSymbol = slugifyCollectionName(c.symbol || '')
  const fromSlug = slugifyCollectionName(c.slug || '')
  const s = fromName || fromSymbol || fromSlug
  if (!s || RESERVED.has(s)) return c.address
  return s
}

export function withPublicSlugs(rows: Collection[]): Collection[] {
  const keys = rows.map(collectionSlug)
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1)
  return rows.map((c, i) => {
    const key = keys[i]
    const unique = key.toLowerCase() !== c.address.toLowerCase() && (counts.get(key) || 0) === 1
    return { ...c, slug: unique ? key : c.address }
  })
}

export function studioPath(c: CollectionPath, extra?: string | number): string {
  const id = c.slug && !RESERVED.has(c.slug.toLowerCase()) ? c.slug : collectionSlug(c)
  if (extra === undefined || extra === '') return `/studio/${id}`
  return `/studio/${id}/${extra}`
}
