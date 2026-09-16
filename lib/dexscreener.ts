/**
 * Dexscreener pair URLs for Instant books.
 *
 * V3 Instant / Reflection: the Uni V3 pool address.
 * V4 Instant / RWA (USDC, cirBTC, USYC, …): the Uniswap v4 poolId (bytes32).
 * Dexscreener indexes both as /arc/{id}. chartType=usd so cirBTC books plot in dollars.
 */
import type { PoolToken } from './tokens'

const ZERO = '0x0000000000000000000000000000000000000000'
const V3_POOL = /^0x[0-9a-fA-F]{40}$/
const V4_POOL_ID = /^0x[0-9a-fA-F]{64}$/

export const DEXSCREENER_CHAIN = 'arc'

export function dexScreenerPairId(
  pool: Pick<PoolToken, 'dexVenue' | 'instantMeta'>,
): string | null {
  const v4 = (pool.instantMeta?.poolId || '').trim()
  if (V4_POOL_ID.test(v4)) return v4.toLowerCase()
  const uni = (pool.instantMeta?.uniPool || '').trim()
  if (V3_POOL.test(uni) && uni.toLowerCase() !== ZERO) return uni.toLowerCase()
  return null
}

export function dexScreenerPairUrl(
  pool: Pick<PoolToken, 'dexVenue' | 'instantMeta'>,
): string | null {
  const id = dexScreenerPairId(pool)
  if (!id) return null
  return `https://dexscreener.com/${DEXSCREENER_CHAIN}/${id}`
}

export function dexScreenerEmbedSrc(
  pool: Pick<PoolToken, 'dexVenue' | 'instantMeta'>,
): string | null {
  const page = dexScreenerPairUrl(pool)
  if (!page) return null
  const q = new URLSearchParams({
    embed: '1',
    loadChartSettings: '0',
    trades: '0',
    tabs: '0',
    info: '0',
    chartLeftToolbar: '0',
    chartTheme: 'dark',
    theme: 'dark',
    chartStyle: '1',
    chartType: 'usd',
    interval: '15',
  })
  return `${page}?${q.toString()}`
}
