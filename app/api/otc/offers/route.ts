/**
 * GET  /api/otc/offers — OTC book (Goldsky preferred → KV indexer fallback).
 * POST /api/otc/offers — optimistic ingest after createOffer (keeps UI instant).
 */
import { NextRequest, NextResponse, after } from 'next/server'
import { getAddress, isAddress, parseAbiItem, type Address, type Hex } from 'viem'
import { getIndexedOtcBook } from '@/lib/arc-indexer/run'
import { upsertOtcOffer } from '@/lib/arc-indexer/store'
import { kv } from '@vercel/kv'
import { jsonSafe } from '@/lib/json-safe'
import { ROBIN_OTC_LIQUIDITY, LIQUIDITY_ABI } from '@/lib/bridge/robin-otc'
import { arcPublicClient } from '@/lib/contracts-arc'
import {
  fetchGoldskyOtcOffers,
  goldskyOtcConfigured,
} from '@/lib/goldsky-otc'
import { getPublicOtcDeskStats } from '@/lib/arc-indexer/otc-desk-stats'
import { scanLogsChunked, LOG_CHUNK } from '@/lib/arc-indexer/logs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const OFFER_CREATED = parseAbiItem(
  'event OfferCreated(bytes32 indexed offerId, address indexed maker, address sellerPayment, uint32 premiumBps, uint256 amount)',
)
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const OTC_FLOOR = 14_000_000n

/**
 * At most one recovery scan per maker per window, across all instances. My orders polls every
 * 10s, so without this a single open tab queues a fresh scan every poll. Returns true only to
 * the caller that claims the slot; a KV failure returns false (skip the scan) rather than
 * letting every poll through.
 */
const RECOVER_THROTTLE_SEC = 10 * 60

async function claimRecoverSlot(maker: Address): Promise<boolean> {
  try {
    const res = await kv.set(`arcfun:otc:recover:${maker.toLowerCase()}`, Date.now(), {
      ex: RECOVER_THROTTLE_SEC,
      nx: true,
    })
    return res === 'OK'
  } catch {
    return false
  }
}

/** Maker-topic OfferCreated backfill when the KV book missed a live offer. */
async function recoverMakerOffers(maker: Address): Promise<number> {
  const client = arcPublicClient()
  const head = await client.getBlockNumber()
  // scanLogsChunked walks ascending from `fromBlock` and stops after maxChunks * LOG_CHUNK
  // blocks, regardless of how far `toBlock` is. Anchoring `from` 1.5M blocks back from head
  // while only ever scanning 720k of them meant the window ended ~780k blocks short of head —
  // never reaching the recent blocks where a just-dropped offer actually lives, so this could
  // never recover one. Anchor to head so the freshest blocks are always covered.
  //
  // 40 chunks (360k blocks, ~1.7 days of Arc) rather than 80: 80 measured >60s against Arc RPC
  // and blew maxDuration. after() defers this past the response but does NOT extend
  // maxDuration, so the scan still has to fit the budget.
  const RECOVER_MAX_CHUNKS = 40
  const window = BigInt(RECOVER_MAX_CHUNKS) * LOG_CHUNK
  const from = head > window ? head - window : OTC_FLOOR
  const { logs } = await scanLogsChunked(client, {
    address: ROBIN_OTC_LIQUIDITY,
    event: OFFER_CREATED,
    fromBlock: from < OTC_FLOOR ? OTC_FLOOR : from,
    toBlock: head,
    maxChunks: RECOVER_MAX_CHUNKS,
    args: { maker },
  })
  let n = 0
  for (const log of logs) {
    const args = (log as { args?: { offerId?: Hex } }).args
    const offerId = args?.offerId
    if (!offerId) continue
    try {
      const row = (await client.readContract({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'offers',
        args: [offerId],
      })) as readonly [Address, Address, number, bigint, boolean]
      const [m, sellerPayment, premiumBps, remaining, active] = row
      if (!active || remaining === 0n || m === ZERO) continue
      await upsertOtcOffer({
        offerId,
        maker: m,
        sellerPayment,
        premiumBps: Number(premiumBps),
        remaining: remaining.toString(),
        active,
        createdBlock: Number(log.blockNumber ?? 0n),
        updatedAt: Date.now(),
      })
      n++
    } catch {
      /* skip one */
    }
  }
  return n
}

export async function GET(req: NextRequest) {
  try {
    const stats = await getPublicOtcDeskStats().catch(() => null)
    const headers = {
      'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
    }
    const makerRaw = (req.nextUrl.searchParams.get('maker') || '').trim()
    const maker = isAddress(makerRaw) ? getAddress(makerRaw) : null

    // Prefer Goldsky when configured (sub-second GraphQL vs KV lag).
    if (goldskyOtcConfigured()) {
      const gs = await fetchGoldskyOtcOffers()
      if (gs !== null) {
        const offers = maker
          ? gs.filter((o) => o.maker.toLowerCase() === maker.toLowerCase())
          : gs
        return jsonSafe(
          {
            ok: true,
            source: 'goldsky',
            at: Date.now(),
            offers,
            stats,
          },
          { headers },
        )
      }
      console.warn('[otc/offers] goldsky miss, falling back to arc-indexer')
    }

    let offers = await getIndexedOtcBook()
    if (maker) {
      const mine = offers.filter((o) => o.maker.toLowerCase() === maker.toLowerCase())
      // Recover AFTER responding, never inline. My orders polls this every 10s
      // (InstantOtcOrders.tsx), and every maker with no indexed offers — i.e. anyone who has
      // never posted liquidity — took the recovery branch. The scan outruns maxDuration, so
      // those callers got a 60s hang ending in FUNCTION_INVOCATION_TIMEOUT (504s observed live)
      // instead of an instant empty list, while burning the most expensive invocation shape
      // there is, once per poll. Responding first costs one poll of latency: whatever the scan
      // re-indexes is served 10s later.
      if (mine.length === 0 && (await claimRecoverSlot(maker))) {
        after(async () => {
          try {
            const n = await recoverMakerOffers(maker)
            if (n > 0) console.info('[otc/offers] maker recover found', n, maker)
          } catch (e) {
            console.warn('[otc/offers] maker recover', e instanceof Error ? e.message : e)
          }
        })
      }
      offers = mine
    }

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
