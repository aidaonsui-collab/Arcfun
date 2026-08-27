/**
 * Launch time for Instant / Reflection tokens.
 *
 * Catalog tokens never got createdAt from the factory, so "New" and the age chip
 * fell through to lastTradeAt (most recent swap, not deploy). This stamps unix
 * seconds from InstantQuoteTokenCreated / InstantReflectionCreated and caches
 * them in KV so a catalog rebuild does not rescan logs.
 */
import { getAddress, parseAbiItem, type Address } from 'viem'
import { kv } from '@vercel/kv'
import { ARC, arcPublicClient } from './contracts-arc'
import { summarizeRpcError } from './rpc-error'
import type { PoolToken } from './tokens'

const KV_KEY = 'arcfun:launch:created:v1'
const FACTORY_FLOOR = 14_000_000n
const LOG_CONCURRENCY = 4

const INSTANT_CREATED = parseAbiItem(
  'event InstantQuoteTokenCreated(address indexed token, address indexed creator, address pool, uint256 positionId)',
)
const REFLECTION_CREATED = parseAbiItem(
  'event InstantReflectionCreated(address indexed token, address indexed creator, address rewardToken, address pool, uint256 positionId, address feeSink)',
)

const LEGACY_INSTANT = '0x607bff9EB2ff1494AC8f0b545502Ce49ee2Ae42B' as Address

type CreatedMap = Record<string, number>

function tokenId(t: PoolToken): string {
  return (t.coinType || t.poolId || t.id || '').toLowerCase()
}

async function readMap(): Promise<CreatedMap> {
  try {
    const row = await kv.get<CreatedMap>(KV_KEY)
    if (row && typeof row === 'object') return row
  } catch {
    /* KV blip */
  }
  return {}
}

async function writeMap(map: CreatedMap): Promise<void> {
  try {
    await kv.set(KV_KEY, map)
  } catch {
    /* best-effort */
  }
}

async function createdAtFromIndexer(ids: string[]): Promise<CreatedMap> {
  const out: CreatedMap = {}
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

function factoryFor(t: PoolToken): Address {
  const f = (t.moonbagsPackageId || '').trim()
  if (f && f.startsWith('0x')) return f as Address
  return t.reflection ? ARC.REFLECTION_FACTORY : ARC.INSTANT_FACTORY
}

async function createdAtFromLogs(tokens: PoolToken[]): Promise<CreatedMap> {
  const out: CreatedMap = {}
  if (tokens.length === 0) return out
  const client = arcPublicClient()
  for (let i = 0; i < tokens.length; i += LOG_CONCURRENCY) {
    const batch = tokens.slice(i, i + LOG_CONCURRENCY)
    await Promise.all(
      batch.map(async (t) => {
        const id = tokenId(t)
        if (!id.startsWith('0x') || id.length !== 42) return
        const token = getAddress(id) as Address
        const reflection = t.launchKind === 'reflection' || t.reflection === true
        const factories: Address[] = reflection
          ? [ARC.REFLECTION_FACTORY]
          : [factoryFor(t), ARC.INSTANT_FACTORY, LEGACY_INSTANT]
        const seen = new Set<string>()
        for (const factory of factories) {
          const key = factory.toLowerCase()
          if (!factory || factory === '0x0000000000000000000000000000000000000000' || seen.has(key)) continue
          seen.add(key)
          try {
            const logs = await client.getLogs({
              address: factory,
              event: reflection ? REFLECTION_CREATED : INSTANT_CREATED,
              args: { token },
              fromBlock: FACTORY_FLOOR,
              toBlock: 'latest',
            })
            const log = logs[0]
            if (!log?.blockNumber) continue
            const block = await client.getBlock({ blockNumber: log.blockNumber })
            const ts = Number(block.timestamp)
            if (Number.isFinite(ts) && ts > 0) {
              out[id] = ts
              return
            }
          } catch (e) {
            console.warn('[arc-launch-created] logs', factory, id, summarizeRpcError(e))
          }
        }
      }),
    )
  }
  return out
}

/** Fill createdAt from KV, then indexer create-blocks, then factory logs. Never uses lastTradeAt. */
export async function attachLaunchCreatedAt(tokens: PoolToken[]): Promise<PoolToken[]> {
  if (tokens.length === 0) return tokens
  const map = await readMap()
  const missing = tokens.filter((t) => {
    const id = tokenId(t)
    return id && !(map[id] > 0) && !(t.createdAt && t.createdAt > 0)
  })
  if (missing.length > 0) {
    const fromIdx = await createdAtFromIndexer(missing.map(tokenId).filter(Boolean))
    Object.assign(map, fromIdx)
    const still = missing.filter((t) => !(map[tokenId(t)] > 0))
    if (still.length > 0) Object.assign(map, await createdAtFromLogs(still))
    if (Object.values(map).some((n) => n > 0)) await writeMap(map)
  }
  return tokens.map((t) => {
    const id = tokenId(t)
    const ts = (t.createdAt && t.createdAt > 0 ? t.createdAt : map[id]) || 0
    return ts > 0 ? { ...t, createdAt: ts } : t
  })
}
