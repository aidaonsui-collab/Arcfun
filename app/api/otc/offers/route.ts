/**
 * GET  /api/otc/offers — OTC book (Goldsky preferred → KV indexer fallback).
 * POST /api/otc/offers — optimistic ingest after createOffer (keeps UI instant).
 */
import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address, type Hex } from 'viem'
import { getIndexedOtcBook } from '@/lib/arc-indexer/run'
import { upsertOtcOffer } from '@/lib/arc-indexer/store'
import { jsonSafe } from '@/lib/json-safe'
import { ROBIN_OTC_LIQUIDITY, LIQUIDITY_ABI } from '@/lib/bridge/robin-otc'
import { arcPublicClient } from '@/lib/contracts-arc'
import {
  fetchGoldskyOtcOffers,
  goldskyOtcConfigured,
} from '@/lib/goldsky-otc'
import { getPublicOtcDeskStats } from '@/lib/arc-indexer/otc-desk-stats'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const stats = await getPublicOtcDeskStats().catch(() => null)
    const headers = {
      'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
    }

    // Prefer Goldsky when configured (sub-second GraphQL vs KV lag).
    if (goldskyOtcConfigured()) {
      const gs = await fetchGoldskyOtcOffers()
      if (gs !== null) {
        // Empty book is valid when Goldsky is healthy.
        return jsonSafe(
          {
            ok: true,
            source: 'goldsky',
            at: Date.now(),
            offers: gs,
            stats,
          },
          { headers },
        )
      }
      // Fall through to KV on Goldsky failure
      console.warn('[otc/offers] goldsky miss, falling back to arc-indexer')
    }

    const offers = await getIndexedOtcBook()
    return jsonSafe(
      {
        ok: true,
        source: 'arc-indexer',
        at: Date.now(),
        offers,
        stats,
      },
      { headers },
    )
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        offers: [],
      },
      { status: 500 },
    )
  }
}

/**
 * Body: { offerId: 0x… }
 * Reads live offers() on Arc and upserts into KV so other clients see it without waiting for cron.
 * Goldsky will catch up via chain events; this keeps create → list instant.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { offerId?: string }
    const offerId = (body.offerId || '').trim() as Hex
    if (!/^0x[a-fA-F0-9]{64}$/.test(offerId)) {
      return NextResponse.json({ ok: false, error: 'invalid offerId' }, { status: 400 })
    }

    const client = arcPublicClient()
    const row = (await client.readContract({
      address: ROBIN_OTC_LIQUIDITY,
      abi: LIQUIDITY_ABI,
      functionName: 'offers',
      args: [offerId],
    })) as readonly [Address, Address, number, bigint, boolean]

    const [maker, sellerPayment, premiumBps, remaining, active] = row
    if (!isAddress(maker) || maker === '0x0000000000000000000000000000000000000000') {
      return NextResponse.json({ ok: false, error: 'offer not found' }, { status: 404 })
    }

    if (!active || remaining === 0n) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'inactive or empty',
      })
    }

    await upsertOtcOffer({
      offerId,
      maker,
      sellerPayment,
      premiumBps: Number(premiumBps),
      remaining: remaining.toString(),
      active,
      updatedAt: Date.now(),
    })

    return NextResponse.json({
      ok: true,
      offerId,
      remaining: remaining.toString(),
      premiumBps: Number(premiumBps),
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
