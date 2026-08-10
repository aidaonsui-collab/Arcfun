/**
 * Opt-in trader identity for chart PFPs — only wallets with ArcFun profile + avatar.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { getCreatorMeta, type CreatorMeta } from '@/lib/arc-creator-meta'

export type TraderMeta = {
  address: Address
  addressChecksum: string
  avatarUrl: string
  displayName?: string
  twitter?: string
}

const MAX_BATCH = 80

/**
 * Resolve public profile meta for many wallets. Only returns entries that have a non-empty avatarUrl
 * (opt-in chart PFP policy).
 */
export async function getTraderMetas(addresses: string[]): Promise<Map<string, TraderMeta>> {
  const out = new Map<string, TraderMeta>()
  const unique: string[] = []
  const seen = new Set<string>()
  for (const raw of addresses) {
    if (!raw || !isAddress(raw)) continue
    const lower = raw.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    unique.push(lower)
    if (unique.length >= MAX_BATCH) break
  }

  await Promise.all(
    unique.map(async (lower) => {
      try {
        const meta: CreatorMeta = await getCreatorMeta(lower)
        const avatarUrl = (meta.avatarUrl || '').trim()
        if (!avatarUrl) return
        const checksum = getAddress(lower)
        out.set(lower, {
          address: checksum as Address,
          addressChecksum: checksum,
          avatarUrl,
          displayName: meta.displayName?.trim() || undefined,
          twitter: meta.twitter?.trim() || undefined,
        })
      } catch {
        /* skip */
      }
    }),
  )
  return out
}

export function traderMetasToJson(map: Map<string, TraderMeta>): Record<string, TraderMeta> {
  const o: Record<string, TraderMeta> = {}
  for (const [k, v] of map) o[k] = v
  return o
}
