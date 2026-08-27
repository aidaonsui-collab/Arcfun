/**
 * Creator profile helpers — tokens launched by a wallet across Instant / Reflection / curve.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { buildArcCatalog } from '@/lib/arc-instant-tokens'
import { isHiddenToken, type PoolToken } from '@/lib/tokens'
import { getCreatorMeta, type CreatorMeta } from '@/lib/arc-creator-meta'
import { getFollowCounts } from '@/lib/arc-followers'
import { listCreatorFeePositions, type CreatorFeePosition } from '@/lib/arc-creator-fees'
import { computeCreatorPnl, type CreatorPnl } from '@/lib/arc-creator-pnl'

export type CreatorProfile = {
  address: Address
  addressChecksum: string
  short: string
  coinsCreated: number
  totalMarketCap: number
  topCoin: {
    address: string
    name: string
    symbol: string
    marketCap: number
    imageUrl: string
  } | null
  latest: {
    address: string
    name: string
    symbol: string
    createdAt?: number
    ageHint: string
  } | null
  tokens: PoolToken[]
  meta: CreatorMeta
  followers: number
  following: number
  feePositions: CreatorFeePosition[]
  pnl: CreatorPnl | null
  source: string
  at: number
}

function creatorKey(t: PoolToken): string {
  return (t.creatorFull || t.creator || '').toLowerCase()
}

/** Tokens where on-chain / stored creator matches `wallet` (case-insensitive). */
export function filterTokensByCreator(tokens: PoolToken[], wallet: string): PoolToken[] {
  const w = wallet.toLowerCase()
  if (!w.startsWith('0x') || w.length !== 42) return []
  return tokens.filter((t) => {
    const c = creatorKey(t)
    if (!c || c !== w) return false
    const id = t.coinType || t.poolId || t.id
    return id ? !isHiddenToken(id) : true
  })
}

function sortForProfile(tokens: PoolToken[]): PoolToken[] {
  return [...tokens].sort((a, b) => {
    const ta = a.createdAt ?? 0
    const tb = b.createdAt ?? 0
    if (tb !== ta) return tb - ta
    return (b.marketCap ?? 0) - (a.marketCap ?? 0)
  })
}

/**
 * Build creator profile from the live Arc catalog (same source as home grid).
 * @param opts.includeFees — load locker fee positions (extra RPC)
 * @param opts.includePnl — scan recent trades for wallet PnL (extra RPC)
 * @param opts.pnlRange — trade window for PnL
 */
export async function buildCreatorProfile(
  walletRaw: string,
  opts?: {
    includeFees?: boolean
    includePnl?: boolean
    pnlRange?: CreatorPnl['range']
  },
): Promise<CreatorProfile | null> {
  if (!isAddress(walletRaw)) return null
  const addressChecksum = getAddress(walletRaw)
  const address = addressChecksum as Address

  const { tokens: catalog, source } = await buildArcCatalog()
  const mine = sortForProfile(filterTokensByCreator(catalog, address))

  let top: CreatorProfile['topCoin'] = null
  let latest: CreatorProfile['latest'] = null
  let totalMarketCap = 0

  for (const t of mine) {
    totalMarketCap += t.marketCap ?? 0
    const addr = t.coinType || t.poolId || t.id
    if (!top || (t.marketCap ?? 0) > top.marketCap) {
      top = {
        address: addr,
        name: t.name,
        symbol: t.symbol,
        marketCap: t.marketCap ?? 0,
        imageUrl: t.imageUrl || t.logoUrl || '',
      }
    }
  }

  if (mine[0]) {
    const t = mine[0]
    const addr = t.coinType || t.poolId || t.id
    latest = {
      address: addr,
      name: t.name,
      symbol: t.symbol,
      createdAt: t.createdAt,
      ageHint: t.age || '',
    }
  }

  const [meta, counts, feePositions, pnl] = await Promise.all([
    getCreatorMeta(address).catch(() => ({}) as CreatorMeta),
    getFollowCounts(address).catch(() => ({ followers: 0, following: 0 })),
    opts?.includeFees !== false
      ? listCreatorFeePositions(mine).catch(() => [] as CreatorFeePosition[])
      : Promise.resolve([] as CreatorFeePosition[]),
    opts?.includePnl !== false
      ? computeCreatorPnl(address, mine, opts?.pnlRange ?? '1W').catch(() => null)
      : Promise.resolve(null),
  ])

  return {
    address,
    addressChecksum,
    short: `${addressChecksum.slice(0, 6)}…${addressChecksum.slice(-4)}`,
    coinsCreated: mine.length,
    totalMarketCap,
    topCoin: top,
    latest,
    tokens: mine,
    meta,
    followers: counts.followers,
    following: counts.following,
    feePositions,
    pnl,
    source,
    at: Date.now(),
  }
}
