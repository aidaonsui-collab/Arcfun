/**
 * GET /api/arc/[token]/holders — seed from Swap traders + balance ranking.
 */
import { NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { fetchEvmHolders, resetHolderLedger } from '@/lib/evm-holders'
import { fetchArcTrades } from '@/lib/arc-trades'
import { fetchArcPoolToken } from '@/lib/arc-instant-tokens'
import { ARC, arcInstantEnabled, instantLockerForFactory, instantProtocolAddresses } from '@/lib/contracts-arc'
import { isReflectionToken } from '@/lib/tokens'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isPlausibleEvmAddress(token)) {
    return NextResponse.json({ error: 'invalid token', holders: [], total: 0 }, { status: 400 })
  }
  if (!arcInstantEnabled()) {
    return NextResponse.json({ error: 'not configured', holders: [], total: 0 }, { status: 404 })
  }
  // Manual catch-up escape hatch for a token whose ledger cursor is well behind head — the
  // background cron shares its time across every known token, so a token can lag noticeably
  // between its cursor being established and full catch-up. Bounded well under maxDuration to
  // leave room for the pool/trades fetch above it; never used unless explicitly requested.
  const url = new URL(req.url)
  const reset = url.searchParams.get('reset') === '1'
  // Recovery for a cursor that already reached head while under-counting — see
  // applyTransferDeltas's comment on the chunk-failure bug this undoes. Wipes the ledger and
  // cursor for this one token; the catch-up budget below always applies alongside it too, so
  // this same request also starts rebuilding rather than just returning a freshly emptied
  // ledger.
  if (reset) await resetHolderLedger(token as Address)
  const catchup = reset || url.searchParams.get('catchup') === '1'

  try {
    // fetchArcPoolToken (not the Instant-only variant) so Reflection and graduated-curve tokens
    // get their holders indexed too — this used to 404 for anything that wasn't a plain Instant
    // launch, even though the pool itself was live and had holders.
    const pool = await fetchArcPoolToken(token as Address)
    if (!pool) {
      return NextResponse.json({ error: 'not found', holders: [], total: 0 }, { status: 404 })
    }
    const factory = (pool.moonbagsPackageId ||
      (isReflectionToken(pool) ? ARC.REFLECTION_FACTORY : ARC.INSTANT_FACTORY)) as Address
    const locker = instantLockerForFactory(factory)

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
        ...instantProtocolAddresses(),
        factory,
        locker,
        ...(pool.instantMeta?.uniPool ? [pool.instantMeta.uniPool] : []),
      ],
      creatorAddress: pool.creator,
      budgetMs: catchup ? 45_000 : undefined,
    })

    return NextResponse.json(result, {
      // A catch-up call is a one-off, not a representative response to cache for other viewers.
      headers: catchup
        ? { 'Cache-Control': 'private, no-store' }
        : { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    console.error('[api/arc/holders]', e)
    return NextResponse.json({ holders: [], total: 0 }, { status: 200 })
  }
}
