/**
 * Launch time for Instant / Reflection tokens.
 *
 * Catalog tokens never got createdAt from the factory, so "New" and the age chip
 * fell through to lastTradeAt. Factory RPCs cap eth_getLogs at 10k blocks, so
 * we walk the InstantQuoteTokenCreated / InstantReflectionCreated logs in 9k
 * chunks from the tip (newest first) and cache unix seconds in KV.
 */
import { parseAbiItem, type Address } from 'viem'
import { kv } from '@vercel/kv'
import { ARC, arcPublicClient, instantCatalogFactories } from './contracts-arc'
import { summarizeRpcError } from './rpc-error'
import type { PoolToken } from './tokens'

const KV_KEY = 'arcfun:launch:created:v2'
const FACTORY_FLOOR = 14_000_000n
const LOG_CHUNK = 9_000n
const MAX_CHUNKS = 48
const PAR = 4

const INSTANT_CREATED = parseAbiItem(
  'event InstantQuoteTokenCreated(address indexed token, address indexed creator, address pool, uint256 positionId)',
)
const REFLECTION_CREATED = parseAbiItem(
  'event InstantReflectionCreated(address indexed token, address indexed creator, address rewardToken, address pool, uint256 positionId, address feeSink)',
)

const ZERO = '0x0000000000000000000000000000000000000000'

type LaunchCreatedState = {
  times: Record<string, number>
  downTo?: string
  upTo?: string
}

function tokenId(t: PoolToken): string {
  return (t.coinType || t.poolId || t.id || '').toLowerCase()
}

async function readState(): Promise<LaunchCreatedState> {
  try {
    const row = await kv.get<LaunchCreatedState>(KV_KEY)
    if (row?.times && typeof row.times === 'object') return row
  } catch {
    /* KV blip */
  }
  return { times: {} }
}

async function writeState(state: LaunchCreatedState): Promise<void> {
  try {
    await kv.set(KV_KEY, state)
  } catch {
    /* best-effort */
  }
}

function factories() {
  return [
    ...instantCatalogFactories().map((address) => ({ address, event: INSTANT_CREATED })),
    { address: ARC.REFLECTION_FACTORY, event: REFLECTION_CREATED },
  ].filter((f) => f.address && f.address !== ZERO)
}

async function createdAtFromIndexer(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (ids.length === 0) return out
  try {
    const { getIndexedTokensMap } = await import('@/lib/arc-indexer/store')
    const rows = await getIndexedTokensMap(ids)
    const client = arcPublicClient()
    const byBlock = new Map<number, string[]>()
    for (const id of ids) {
      const row = rows[id]
      if (!row?.createdBlock || row.createdBlock <= 0) continue
      const list = byBlock.get(row.createdBlock) ?? []
      list.push(id)
      byBlock.set(row.createdBlock, list)
    }
    await Promise.all(
      [...byBlock.entries()].map(async ([blockNumber, tokenIds]) => {
        try {
          const block = await client.getBlock({ blockNumber: BigInt(blockNumber) })
          const ts = Number(block.timestamp)
          if (!Number.isFinite(ts) || ts <= 0) return
          for (const id of tokenIds) out[id] = ts
        } catch (e) {
          console.warn('[arc-launch-created] block', blockNumber, summarizeRpcError(e))
        }
      }),
    )
  } catch (e) {
    console.warn('[arc-launch-created] indexer', summarizeRpcError(e))
  }
  return out
}

async function timestampLogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logs: any[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const client = arcPublicClient()
  const byBlock = new Map<string, string[]>()
  for (const log of logs) {
    const token = (log?.args?.token as string | undefined)?.toLowerCase()
    const bn = log?.blockNumber != null ? String(log.blockNumber) : ''
    if (!token || !bn) continue
    const list = byBlock.get(bn) ?? []
    list.push(token)
    byBlock.set(bn, list)
  }
  await Promise.all(
    [...byBlock.entries()].map(async ([bn, tokenIds]) => {
      try {
        const block = await client.getBlock({ blockNumber: BigInt(bn) })
        const ts = Number(block.timestamp)
        if (!Number.isFinite(ts) || ts <= 0) return
        for (const id of tokenIds) out[id] = ts
      } catch (e) {
        console.warn('[arc-launch-created] ts', bn, summarizeRpcError(e))
      }
    }),
  )
  return out
}

/** Newest-first 9k windows. Arc public RPCs reject eth_getLogs wider than 10k. */
async function scanFactoryWindow(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Record<string, number>> {
  const client = arcPublicClient()
  const out: Record<string, number> = {}
  for (const { address, event } of factories()) {
    try {
      const logs = await client.getLogs({
        address,
        event,
        fromBlock,
        toBlock,
      })
      Object.assign(out, await timestampLogs(logs))
    } catch (e) {
      console.warn('[arc-launch-created] window', address, fromBlock.toString(), summarizeRpcError(e))
    }
  }
  return out
}

async function backfillLogs(
  state: LaunchCreatedState,
  stillMissing: number,
): Promise<LaunchCreatedState> {
  if (stillMissing <= 0) return state
  const client = arcPublicClient()
  let head = 0n
  try {
    head = await client.getBlockNumber()
  } catch (e) {
    console.warn('[arc-launch-created] head', summarizeRpcError(e))
    return state
  }

  const times = { ...state.times }
  let downTo = state.downTo ? BigInt(state.downTo) : head
  let upTo = state.upTo ? BigInt(state.upTo) : 0n

  if (upTo > 0n && upTo < head) {
    Object.assign(times, await scanFactoryWindow(upTo + 1n, head))
    upTo = head
  }

  const ranges: { from: bigint; to: bigint }[] = []
  let cursor = downTo
  while (ranges.length < MAX_CHUNKS && cursor > FACTORY_FLOOR) {
    const to = cursor
    const from = to >= FACTORY_FLOOR + LOG_CHUNK - 1n ? to - LOG_CHUNK + 1n : FACTORY_FLOOR
    ranges.push({ from, to })
    cursor = from > 0n ? from - 1n : 0n
    if (from <= FACTORY_FLOOR) break
  }

  if (ranges.length && upTo === 0n) upTo = ranges[0].to

  for (let i = 0; i < ranges.length; i += PAR) {
    const batch = ranges.slice(i, i + PAR)
    const parts = await Promise.all(batch.map((r) => scanFactoryWindow(r.from, r.to)))
    for (const part of parts) Object.assign(times, part)
    const lowest = batch[batch.length - 1].from
    if (lowest < downTo) downTo = lowest
    await writeState({ times, downTo: downTo.toString(), upTo: upTo.toString() })
  }

  return { times, downTo: downTo.toString(), upTo: upTo.toString() }
}

/** Fill createdAt from KV, then indexer create-blocks, then factory logs. Never uses lastTradeAt. */
export async function attachLaunchCreatedAt(tokens: PoolToken[]): Promise<PoolToken[]> {
  if (tokens.length === 0) return tokens
  const state = await readState()
  const map = { ...state.times }
  const missing = tokens.filter((t) => {
    const id = tokenId(t)
    return id && !(map[id] > 0) && !(t.createdAt && t.createdAt > 0)
  })
  if (missing.length > 0) {
    Object.assign(map, await createdAtFromIndexer(missing.map(tokenId).filter(Boolean)))
    const still = missing.filter((t) => !(map[tokenId(t)] > 0)).length
    const next = await backfillLogs({ ...state, times: map }, still)
    Object.assign(map, next.times)
    if (Object.values(map).some((n) => n > 0) || next.downTo) {
      await writeState({ ...next, times: map })
    }
  }
  return tokens.map((t) => {
    const id = tokenId(t)
    const ts = (t.createdAt && t.createdAt > 0 ? t.createdAt : map[id]) || 0
    return ts > 0 ? { ...t, createdAt: ts } : t
  })
}
