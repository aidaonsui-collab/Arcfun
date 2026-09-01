/**
 * Overlay signed listing fields (pfp / socials) onto a catalog row.
 * Catalog snapshots lag KV by the indexer interval; reads must not trust the snapshot alone.
 */
import type { ArcTokenMeta } from './arc-token-meta'
import type { PoolToken } from './tokens'

export function applyListingMeta(t: PoolToken, meta?: ArcTokenMeta | null): PoolToken {
  if (!meta) return t
  const imageUrl = meta.imageUrl || t.imageUrl || ''
  return {
    ...t,
    name: t.name || meta.name || t.symbol,
    symbol: t.symbol || meta.symbol || '',
    description: meta.description ?? t.description ?? '',
    imageUrl,
    logoUrl: imageUrl || t.logoUrl || '',
    twitter: meta.twitter ?? t.twitter ?? '',
    telegram: meta.telegram ?? t.telegram ?? '',
    website: meta.website ?? t.website ?? '',
    streamUrl: meta.streamUrl ?? t.streamUrl ?? '',
  }
}
