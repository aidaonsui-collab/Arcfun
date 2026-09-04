/**
 * Home catalog + token pages from the indexer KV when Instant RPC returns nothing.
 *
 * Live 2026-09-01: `/api/arc/tokens` served `tokens: []` with source `arc-instant+idx`
 * while `/api/arc/indexer/status` still had tokenCount 35 and EVE 404'd. Instant
 * factory enumeration timed out, the 10-minute catalog snapshot expired, and the
 * empty rebuild was persisted. An empty snapshot is not "the pad has zero launches".
 */
import type { Address } from 'viem'
import { arcMarketCapUsd, healIndexedSpotUsdc, sanitizePoolTokenSpot } from './arc-instant-tokens'
import type { ArcTokenMeta } from './arc-token-meta'
import type { IndexedToken, IndexedVolume } from './arc-indexer/types'
import type { PoolToken } from './tokens'

const ZERO = '0x0000000000000000000000000000000000000000'
const TOTAL_SUPPLY_HUMAN = 1_000_000_000
const REFLECTION_FACTORY = '0xa4957e724696b740b323ff3536415bb945e46828'

export function isUsableCatalogSnapshot<T extends { tokens?: unknown; at?: number }>(
  row: T | null | undefined,
): row is T & { tokens: unknown[] } {
  return Boolean(row && Array.isArray(row.tokens) && row.tokens.length > 0 && row.at)
}

export function catalogId(t: Pick<PoolToken, 'coinType' | 'poolId' | 'id'>): string {
  return (t.coinType || t.poolId || t.id || '').toLowerCase()
}

function tradeTs(t: Pick<PoolToken, 'lastTradeAt'>): number {
  const n = t.lastTradeAt
  return typeof n === 'number' && n > 0 ? n : 0
}

/**
 * RPC/catalog rows win on identity; indexer fills ids the rebuild missed.
 * When fallback lastTradeAt is newer (or primary has none), take trade/volume
 * fields from fallback and keep Instant metadata (name, image, instantMeta).
 * Price/mcap/spark are healed first: a stale 6dp-as-18 print must not overwrite
 * a live slot0, and a zero fallback must not wipe a plausible primary spot.
 */
export function mergeCatalogTokens(primary: PoolToken[], fallback: PoolToken[]): PoolToken[] {
  const byId = new Map<string, PoolToken>()
  for (const t of primary) {
    const id = catalogId(t)
    if (id) byId.set(id, sanitizePoolTokenSpot(t))
  }
  for (const t of fallback) {
    const id = catalogId(t)
    if (!id) continue
    const existing = byId.get(id)
    const healed = sanitizePoolTokenSpot(t)
    if (!existing) {
      byId.set(id, healed)
      continue
    }
    const fallbackAt = tradeTs(healed)
    const primaryAt = tradeTs(existing)
    if (fallbackAt > primaryAt) {
      const fallbackPx = healIndexedSpotUsdc(healed.currentPrice)
      byId.set(id, {
        ...existing,
        ...(fallbackPx > 0
          ? { currentPrice: fallbackPx, marketCap: arcMarketCapUsd(fallbackPx) }
          : {}),
        lastTradeAt: healed.lastTradeAt,
        volume1h: healed.volume1h,
        volume6h: healed.volume6h,
        volume12h: healed.volume12h,
        volume24h: healed.volume24h,
        volumeAll: healed.volumeAll,
        priceChange24h: healed.priceChange24h,
        sparkCloses: healed.sparkCloses ?? existing.sparkCloses,
      })
    }
  }
  return [...byId.values()].map((t) => sanitizePoolTokenSpot(t))
}

function shortAddr(a: string): string {
  if (!a || a.toLowerCase() === ZERO) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function lastSparkClose(vol: IndexedVolume | null | undefined): number {
  const closes = vol?.sparkCloses
  if (!closes?.length) return 0
  const last = closes[closes.length - 1]
  return Number.isFinite(last) && last > 0 ? last : 0
}

export function indexedRowToPoolToken(
  row: IndexedToken,
  meta: ArcTokenMeta | null | undefined,
  vol: IndexedVolume | null | undefined,
  quote = 'USDC',
): PoolToken {
  const token = row.token
  const creator =
    row.creator && row.creator.toLowerCase() !== ZERO
      ? row.creator
      : ((meta?.creator as Address | undefined) ?? ZERO)
  const symbol = meta?.symbol || ''
  const name = meta?.name || symbol || shortAddr(token) || token
  const price = healIndexedSpotUsdc(lastSparkClose(vol))
  const factory = (row.factory || '') as Address
  const isReflection =
    row.kind === 'reflection' || factory.toLowerCase() === REFLECTION_FACTORY
  const isCurve = row.kind === 'curve'
  const uniPool = row.pool && row.pool.toLowerCase() !== ZERO ? row.pool : undefined
  return sanitizePoolTokenSpot({
    id: token,
    chain: 'arc',
    poolId: token,
    coinType: token,
    name,
    symbol,
    description: meta?.description ?? '',
    imageUrl: meta?.imageUrl ?? '',
    logoUrl: meta?.imageUrl ?? '',
    twitter: meta?.twitter ?? '',
    telegram: meta?.telegram ?? '',
    website: meta?.website ?? '',
    streamUrl: meta?.streamUrl ?? '',
    creator,
    creatorShort: shortAddr(creator),
    creatorFull: creator,
    currentPrice: price,
    realSuiRaised: 0,
    threshold: 0,
    progress: 100,
    bondingProgress: 100,
    isCompleted: true,
    instantLaunch: !isCurve,
    instant: !isCurve,
    reflection: isReflection,
    launchKind: isReflection ? 'reflection' : isCurve ? 'curve' : 'instant',
    instantMeta: {
      uniPool,
      positionId: '0',
      isMeme: quote === 'USDC',
      isRwaBacked: quote !== 'USDC',
      isMarginBacked: false,
      dexId: 0,
      quote,
    },
    dexVenue: 'v3',
    moonbagsPackageId: factory || undefined,
    volume1h: vol?.volume1h ?? 0,
    volume6h: vol?.volume6h,
    volume12h: vol?.volume12h,
    volume24h: vol?.volume24h,
    volumeAll: vol?.volumeAll,
    lastTradeAt: vol?.lastTradeAt,
    priceChange24h: vol?.priceChange24h ?? 0,
    sparkCloses: vol?.sparkCloses,
    age: '',
    marketCap: arcMarketCapUsd(price),
    totalSupply: TOTAL_SUPPLY_HUMAN,
    createdAt: row.createdAt || undefined,
  })
}

export async function poolTokensFromIndexed(): Promise<PoolToken[]> {
  const { listTokenAddresses, getIndexedTokensMap, getVolumesMap } = await import('./arc-indexer/store')
  const { getArcTokenMetas } = await import('./arc-token-meta')
  const { isHiddenToken } = await import('./tokens')
  const { quoteSymbolForFactory } = await import('./arc-rwa-assets')
  const ids = (await listTokenAddresses()).filter((id) => id && !isHiddenToken(id))
  if (ids.length === 0) return []
  const [rowMap, volMap, metas] = await Promise.all([
    getIndexedTokensMap(ids),
    getVolumesMap(ids),
    getArcTokenMetas(ids).catch(() => new Map<string, ArcTokenMeta>()),
  ])
  const out: PoolToken[] = []
  for (const id of ids) {
    const row = rowMap[id]
    if (!row?.token) continue
    out.push(
      indexedRowToPoolToken(
        row,
        metas.get(id) ?? null,
        volMap[id] ?? null,
        quoteSymbolForFactory(row.factory),
      ),
    )
  }
  return out
}

export async function getIndexedPoolToken(address: string): Promise<PoolToken | null> {
  const needle = (address || '').toLowerCase()
  if (!needle) return null
  const { isHiddenToken } = await import('./tokens')
  if (isHiddenToken(needle)) return null
  const { getToken, getVolume } = await import('./arc-indexer/store')
  const { getArcTokenMeta } = await import('./arc-token-meta')
  const row = await getToken(needle)
  if (!row?.token || isHiddenToken(row.token)) return null
  const { quoteSymbolForFactory } = await import('./arc-rwa-assets')
  const [meta, vol] = await Promise.all([
    getArcTokenMeta(row.token).catch(() => null),
    getVolume(row.token).catch(() => null),
  ])
  return indexedRowToPoolToken(row, meta, vol, quoteSymbolForFactory(row.factory))
}
