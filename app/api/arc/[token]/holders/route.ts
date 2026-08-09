/**
 * GET /api/arc/[token]/holders — seed from Swap traders + balance ranking.
 */
import { NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { fetchEvmHolders } from '@/lib/evm-holders'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcPoolToken } from '@/lib/arc-instant-tokens'
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
    // fetchArcPoolToken (not the Instant-only variant) so Reflection and graduated-curve tokens
    // get their holders indexed too — this used to 404 for anything that wasn't a plain Instant
    // launch, even though the pool itself was live and had holders.
    const pool = await fetchArcPoolToken(token as Address)
    if (!pool) {
      return NextResponse.json({ error: 'not found', holders: [], total: 0 }, { status: 404 })
    }
    const isReflection = pool.moonbagsPackageId?.toLowerCase() === ARC.REFLECTION_FACTORY.toLowerCase()
    const factory = isReflection ? ARC.REFLECTION_FACTORY : ARC.INSTANT_FACTORY
    const locker = isReflection ? ARC.REFLECTION_LOCKER : ARC.INSTANT_LOCKER

    // Seed candidates from recent swap traders so Transfer scan has somewhere to start.
    const trades = await fetchArcTrades(token as Address)
    const seed = Array.from(
      new Set([
        ...trades.trades.map((t) => t.trader.toLowerCase()),
        pool.creator?.toLowerCase(),
        factory.toLowerCase(),
        locker.toLowerCase(),
      ].filter(Boolean) as string[]),
    )

    const result = await fetchEvmHolders('arc', token as Address, {
      seedAddresses: seed,
      excludeAddresses: [
        factory,
        locker,
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
