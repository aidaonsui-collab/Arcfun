/**
 * Server-only Crucible Burn tape. Imported from app/crucible/page.tsx, not from
 * client bundles — keeps lib/crucible.ts browser-safe.
 *
 * Indexes `Burn` from Crucible.cook() on the sink (CrucibleLock.crucible()).
 * Do not gate on NEXT_PUBLIC_CRUCIBLE_ONCHAIN — that flag mislabels old MonLock pools.
 *
 * Live 2026-09-02: /crucible always showed $0 / "No burns yet" because fetchCrucibleStats
 * scanned up to 80 × 9k getLogs from block 18_000_000 on the request, then the page's 12s
 * deadline discarded the work. First cook is block 18433541. Persist the tape in KV and
 * only scan a few chunks per request from the cursor.
 */
import { after } from 'next/server'
import { kv } from '@vercel/kv'
import { erc20Abi, formatUnits, isAddress, parseAbiItem, type Address } from 'viem'
import { scanLogsChunked } from '@/lib/arc-indexer/logs'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { summarizeRpcError } from '@/lib/rpc-error'
import {
  ARCFUN_TOKEN,
  ZERO_ADDRESS,
  type CrucibleMelt,
  type CrucibleStats,
} from '@/lib/crucible'

const BURN_EVENT = parseAbiItem(
  'event Burn(address indexed token, uint256 usdcIn, uint256 eveOut, uint256 ts)',
)
const CRUCIBLE_GETTER = parseAbiItem('function crucible() view returns (address)')

/** Neighborhood of the first live cook (block 18433541). Not genesis. */
const DEFAULT_FROM_BLOCK = 18_433_000n
const FALLBACK_SINK = '0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6' as Address
const FALLBACK_EVE = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF' as Address
const USDC_DECIMALS = 6
const DEFAULT_EVE_DECIMALS = 18
const REQUEST_CHUNKS = 6
const BG_CHUNKS = 24
const KV_KEY = 'arcfun:crucible:tape:v1'
const KV_TTL_SEC = 30 * 24 * 60 * 60

/** First live cook 2026-08-31 (tx 0xd4422fcd…, 2.02 USDC → 17.6k $EVE). */
const SEED_MELTS: CrucibleMelt[] = [
  {
    id: '0xd4422fcd3558e5f4791f04e9e02497d2e11606f203c8fe14f8b7551a4440113c',
    ts: 1788175354,
    usdcIn: 2.019608,
    arcfunBought: 17604.555428796786,
    arcfunBurned: 17604.555428796786,
    preview: false,
  },
]

type TapeRow = {
  sink: string
  scannedTo: string
  melts: CrucibleMelt[]
  at: number
}

let memory: TapeRow | null = null
let inflight: Promise<TapeRow> | null = null

function fromBlockEnv(): bigint {
  const raw = (process.env.CRUCIBLE_BURN_FROM_BLOCK || '').replace(/_/g, '').trim()
  if (!raw) return DEFAULT_FROM_BLOCK
  try {
    const n = BigInt(raw)
    return n > 0n ? n : DEFAULT_FROM_BLOCK
  } catch {
    return DEFAULT_FROM_BLOCK
  }
}

function asAddress(raw: unknown): Address | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || !isAddress(s) || s.toLowerCase() === ZERO_ADDRESS) return null
  return s as Address
}

function mergeMelts(a: CrucibleMelt[], b: CrucibleMelt[]): CrucibleMelt[] {
  const byId = new Map<string, CrucibleMelt>()
  for (const m of [...a, ...b]) {
    if (m?.id) byId.set(m.id.toLowerCase(), m)
  }
  return [...byId.values()].sort((x, y) => y.ts - x.ts || x.id.localeCompare(y.id))
}

function statsFrom(melts: CrucibleMelt[], burnedPctLive: number | null): CrucibleStats {
  const list = mergeMelts(melts, [])
  let usdcIn = 0
  let arcfunBought = 0
  let arcfunAtDead = 0
  for (const m of list) {
    usdcIn += m.usdcIn
    arcfunBought += m.arcfunBought
    arcfunAtDead += m.arcfunBurned
  }
  return {
    usdcIn,
    arcfunBought,
    arcfunAtDead,
    burnedPct: burnedPctLive,
    lastMelt: list[0] ?? null,
    melts: list,
    preview: false,
  }
}

async function readKv(): Promise<TapeRow | null> {
  if (memory?.melts?.length) return memory
  try {
    const row = await kv.get<TapeRow>(KV_KEY)
    if (row && Array.isArray(row.melts) && row.melts.length > 0) {
      memory = row
      return row
    }
  } catch {
    /* local / KV blip */
  }
  return memory
}

async function writeKv(row: TapeRow): Promise<void> {
  memory = row
  try {
    await kv.set(KV_KEY, row, { ex: KV_TTL_SEC })
  } catch {
    /* best-effort */
  }
}

async function resolveCrucibleSink(): Promise<Address> {
  const client = arcPublicClient()
  try {
    const sink = await client.readContract({
      address: ARC.INSTANT_LOCKER,
      abi: [CRUCIBLE_GETTER],
      functionName: 'crucible',
    })
    const addr = asAddress(sink)
    if (addr) return addr
  } catch {
    /* INSTANT_LOCKER may still be MonLock — no crucible() */
  }
  return asAddress(process.env.NEXT_PUBLIC_CRUCIBLE) ?? FALLBACK_SINK
}

async function readEveDecimals(token: Address | null): Promise<number> {
  const client = arcPublicClient()
  const candidates = [token, asAddress(ARCFUN_TOKEN), FALLBACK_EVE].filter(Boolean) as Address[]
  const seen = new Set<string>()
  for (const addr of candidates) {
    const k = addr.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    try {
      const d = await client.readContract({
        address: addr,
        abi: erc20Abi,
        functionName: 'decimals',
      })
      const n = Number(d)
      if (Number.isInteger(n) && n > 0 && n <= 36) return n
    } catch {
      /* try next */
    }
  }
  return DEFAULT_EVE_DECIMALS
}

type BurnArgs = {
  token?: Address
  usdcIn?: bigint
  eveOut?: bigint
  ts?: bigint
}

function meltsFromLogs(
  logs: { args?: BurnArgs; transactionHash?: `0x${string}` }[],
  eveDecimals: number,
): CrucibleMelt[] {
  const melts: CrucibleMelt[] = []
  for (const log of logs) {
    const args = log.args
    const usdcInRaw = args?.usdcIn
    const eveOutRaw = args?.eveOut
    const txHash = log.transactionHash
    if (usdcInRaw == null || eveOutRaw == null || !txHash) continue
    const ts = args?.ts != null ? Number(args.ts) : 0
    const eveOut = Number(formatUnits(eveOutRaw, eveDecimals))
    melts.push({
      id: txHash,
      ts,
      usdcIn: Number(formatUnits(usdcInRaw, USDC_DECIMALS)),
      arcfunBought: eveOut,
      arcfunBurned: eveOut,
      preview: false,
    })
  }
  return melts
}

async function scanFrom(fromBlock: bigint, maxChunks: number): Promise<{ melts: CrucibleMelt[]; scannedTo: bigint; sink: Address }> {
  const client = arcPublicClient()
  const sink = await resolveCrucibleSink()
  const toBlock = await client.getBlockNumber()
  const start = fromBlock > toBlock ? toBlock : fromBlock
  const { logs, scannedTo } = await scanLogsChunked(client, {
    address: sink,
    event: BURN_EVENT,
    fromBlock: start,
    toBlock,
    maxChunks,
  })
  let sampleToken: Address | null = null
  for (const log of logs) {
    const token = asAddress((log as { args?: BurnArgs }).args?.token)
    if (token) {
      sampleToken = token
      break
    }
  }
  const eveDecimals = await readEveDecimals(sampleToken)
  return {
    sink,
    melts: meltsFromLogs(logs as { args?: BurnArgs; transactionHash?: `0x${string}` }[], eveDecimals),
    scannedTo: scannedTo && scannedTo > 0n ? scannedTo : start,
  }
}

async function refresh(maxChunks: number): Promise<TapeRow> {
  if (inflight) return inflight
  inflight = (async () => {
    const prev = (await readKv()) ?? {
      sink: FALLBACK_SINK,
      scannedTo: (fromBlockEnv() - 1n).toString(),
      melts: SEED_MELTS,
      at: 0,
    }
    const cursor = BigInt(prev.scannedTo || '0') + 1n
    const from = cursor > 0n ? cursor : fromBlockEnv()
    try {
      const next = await scanFrom(from, maxChunks)
      const melts = mergeMelts(prev.melts, next.melts)
      const scannedTo =
        next.scannedTo > cursor - 1n ? next.scannedTo.toString() : prev.scannedTo
      const row: TapeRow = {
        sink: next.sink,
        scannedTo,
        melts: melts.length ? melts : SEED_MELTS,
        at: Date.now(),
      }
      await writeKv(row)
      return row
    } catch (e) {
      console.warn('[crucible-stats] refresh', summarizeRpcError(e))
      const fallback: TapeRow = {
        ...prev,
        melts: prev.melts.length ? prev.melts : SEED_MELTS,
        at: prev.at || Date.now(),
      }
      memory = fallback
      return fallback
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

function scheduleRefresh(): void {
  if (inflight) return
  const run = () => {
    void refresh(BG_CHUNKS).catch((e) => console.warn('[crucible-stats] bg', summarizeRpcError(e)))
  }
  try {
    after(run)
  } catch {
    run()
  }
}

export async function fetchCrucibleStats(
  burnedPctLive: number | null,
): Promise<CrucibleStats> {
  try {
    const prev = await readKv()
    if (prev?.melts.length) {
      const stale = Date.now() - (prev.at || 0) > 20_000
      if (stale) scheduleRefresh()
      return statsFrom(prev.melts, burnedPctLive)
    }
    const row = await refresh(REQUEST_CHUNKS)
    return statsFrom(row.melts.length ? row.melts : SEED_MELTS, burnedPctLive)
  } catch {
    return statsFrom(SEED_MELTS, burnedPctLive)
  }
}
