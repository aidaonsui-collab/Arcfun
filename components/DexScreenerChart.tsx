'use client'

import { dexScreenerEmbedSrc } from '@/lib/dexscreener'
import type { PoolToken } from '@/lib/tokens'

/**
 * Token-page chart: Dexscreener embed for every Instant pair type
 * (V3 USDC, V4 USDC, cirBTC, USYC, Reflection). Same URL Dexscreener uses for the book.
 */
export function DexScreenerChart({
  pool,
  symbol,
}: {
  pool: PoolToken
  symbol?: string
}) {
  const src = dexScreenerEmbedSrc(pool)
  const quote = pool.instantMeta?.quote || 'USDC'
  const ticker = symbol || pool.symbol || 'TOKEN'
  const title = `${ticker}/${quote} on Dexscreener`

  if (!src) {
    return (
      <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-t3">
        Chart appears once Dexscreener indexes this pool.
      </div>
    )
  }

  return (
    <iframe
      title={title}
      src={src}
      className="h-full min-h-[380px] w-full border-0"
      allow="clipboard-write; fullscreen"
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
  )
}
