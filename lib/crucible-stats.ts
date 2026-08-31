/**
 * Server-only Crucible Burn tape. Imported from app/crucible/page.tsx, not from
 * client bundles — keeps lib/crucible.ts browser-safe.
 *
 * Indexes `Burn` from Crucible.cook() on the sink (CrucibleLock.crucible()).
 * Do not gate on NEXT_PUBLIC_CRUCIBLE_ONCHAIN — that flag mislabels old MonLock pools.
 */
import { erc20Abi, formatUnits, isAddress, parseAbiItem, type Address } from 'viem'
import { scanLogsChunked, LOG_CHUNK } from '@/lib/arc-indexer/logs'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import {
  ARCFUN_TOKEN,
  ZERO_ADDRESS,
  emptyCrucibleStats,
  type CrucibleMelt,
  type CrucibleStats,
} from '@/lib/crucible'

const BURN_EVENT = parseAbiItem(
  'event Burn(address indexed token, uint256 usdcIn, uint256 eveOut, uint256 ts)',
)
const CRUCIBLE_GETTER = parseAbiItem('function crucible() view returns (address)')

/** First live cook is block 18433541. Scan from near deploy, not genesis. */
const DEFAULT_FROM_BLOCK = 18_000_000n
const FALLBACK_SINK = '0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6' as Address
const FALLBACK_EVE = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF' as Address
const USDC_DECIMALS = 6
const DEFAULT_EVE_DECIMALS = 18
const MAX_BURN_CHUNKS = 80

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

export async function fetchCrucibleStats(
  burnedPctLive: number | null,
): Promise<CrucibleStats> {
  try {
    const client = arcPublicClient()
    const sink = await resolveCrucibleSink()
    const toBlock = await client.getBlockNumber()
    const floor = fromBlockEnv()
    const fromBlock = floor > toBlock ? toBlock : floor
    const span = toBlock - fromBlock + 1n
    const needed = Number((span + LOG_CHUNK - 1n) / LOG_CHUNK)
    const maxChunks = Math.min(Math.max(needed, 1), MAX_BURN_CHUNKS)

    const { logs } = await scanLogsChunked(client, {
      address: sink,
      event: BURN_EVENT,
      fromBlock,
      toBlock,
      maxChunks,
    })

    let sampleToken: Address | null = null
    for (const log of logs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const token = asAddress((log as any).args?.token)
      if (token) {
        sampleToken = token
        break
      }
    }
    const eveDecimals = await readEveDecimals(sampleToken)

    const melts: CrucibleMelt[] = []
    for (const log of logs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (log as any).args as BurnArgs | undefined
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
    melts.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))

    let usdcIn = 0
    let arcfunBought = 0
    let arcfunAtDead = 0
    for (const m of melts) {
      usdcIn += m.usdcIn
      arcfunBought += m.arcfunBought
      arcfunAtDead += m.arcfunBurned
    }

    return {
      usdcIn,
      arcfunBought,
      arcfunAtDead,
      burnedPct: burnedPctLive,
      lastMelt: melts[0] ?? null,
      melts,
      preview: false,
    }
  } catch {
    return emptyCrucibleStats(burnedPctLive)
  }
}
