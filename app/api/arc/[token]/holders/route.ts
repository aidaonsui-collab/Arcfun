/**
 * GET /api/arc/[token]/holders — seed from Swap traders + balance ranking.
 */
import { NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { fetchEvmHolders } from '@/lib/evm-holders'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcInstantPoolToken } from '@/lib/arc-instant-tokens'
import { ARC, arcInstantEnabled } from '@/lib/contracts-arc'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token', holders: [], total: 0 }, { status: 400 })
  }
  if (!arcInstantEnabled()) {
    return NextResponse.json({ error: 'not configured', holders: [], total: 0 }, { status: 404 })
  }

  try {
    const pool = await fetchArcInstantPoolToken(token as Address)
    if (!pool) {
      return NextResponse.json({ error: 'not found', holders: [], total: 0 }, { status: 404 })
    }

    // Seed candidates from recent swap traders so Transfer scan has somewhere to start.
    const trades = await fetchArcTrades(token as Address)
    const seed = Array.from(
      new Set([
        ...trades.trades.map((t) => t.trader.toLowerCase()),
        pool.creator?.toLowerCase(),
        ARC.INSTANT_FACTORY.toLowerCase(),
        ARC.INSTANT_LOCKER.toLowerCase(),
      ].filter(Boolean) as string[]),
    )

    const result = await fetchEvmHolders('arc', token as Address, {
      seedAddresses: seed,
      excludeAddresses: [
        ARC.INSTANT_FACTORY,
        ARC.INSTANT_LOCKER,
        ...(pool.instantMeta?.uniPool ? [pool.instantMeta.uniPool] : []),
      ],
      creatorAddress: pool.creator,
    })

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    console.error('[api/arc/holders]', e)
    return NextResponse.json({ holders: [], total: 0 }, { status: 200 })
  }
}
