/**
 * Arc holder indexer — discovers wallets from Transfer logs + trade-tape seeds, reads balances via
 * multicall, ranks holders excluding the Instant factory/locker/pool addresses.
 *
 * Trimmed from Robinpad's `lib/evm-holders.ts`: that version is parameterized over every EVM chain
 * (`EvmChain`) and also folds in RH4663's $ROBIN staking-pool balances. This fork only ever talks
 * to Arc, so it's hardwired to `arcPublicClient()`/`ARC.INSTANT_FACTORY` and drops the staking
 * lookup entirely. Kept the same exported signature (`fetchEvmHolders(chain, token, opts)`, chain
 * always `'arc'`) so `app/api/arc/[token]/holders/route.ts` — copied verbatim from that repo —
 * didn't need editing.
 */
import { kv } from '@vercel/kv'
import { encodeAbiParameters, erc20Abi, keccak256, parseAbiItem, toHex, type Address, type Log } from 'viem'
import { ARC, arcLogsClient, arcPublicClient, instantProtocolAddresses } from './contracts-arc'
import { mapWithConcurrency } from './concurrency'
import { withRateLimitRetry } from './rpc-retry'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
type TransferLog = Log<bigint, number, false, typeof TRANSFER, true>
const DEAD = '0x000000000000000000000000000000000000dead' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const BALANCE_FANOUT = 8
const TRANSFER_LOG_CHUNK = 9_000n
/** Wall-clock budget for one request's chunked catch-up scan — see upstream note this was copied
 *  from: keeps a cold cache's full-history backfill from blocking past a serverless timeout. */
const SCAN_BUDGET_MS = 8_000
const TOKEN_DECIMALS = 6 // see lib/token-format.ts note on the ARC.TOKEN_DECIMALS=18 mismatch

interface HolderScanCache {
  addresses: string[]
  lastBlock: number
  updatedAt: number
}
const HOLDER_SCAN_KV_KEY = (token: Address) => `arcfun:holderscan:${token.toLowerCase()}`
const HOLDER_SCAN_KV_TTL_S = 30 * 24 * 60 * 60

async function kvGetSafe<T>(key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key)
  } catch {
    return null
  }
}
async function kvSetSafe(key: string, value: unknown, exSeconds: number): Promise<void> {
  try {
    await kv.set(key, value, { ex: exSeconds })
  } catch {
    /* best-effort */
  }
}

export interface EvmHolder {
  rank: number
  address: string
  balance: string
  percentage: number
  isDev?: boolean
}

export interface EvmHoldersResult {
  total: number
  holders: EvmHolder[]
}

function toPercent(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0
  return Math.round(Number((numerator * 10000n) / denominator)) / 100
}

function fmtBalance(raw: bigint): string {
  const n = Number(raw) / 10 ** TOKEN_DECIMALS
  if (n >= 1_000_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n > 0) return n.toPrecision(4)
  return '0'
}

function isExcludedHolder(addr: string, factory: Address): boolean {
  const a = addr.toLowerCase()
  return a === factory.toLowerCase() || a === DEAD.toLowerCase() || a === ZERO.toLowerCase()
}

async function scanTransferLogsChunked(
  token: Address,
  fromBlock: bigint,
  head: bigint,
): Promise<{ addresses: Set<string>; lastBlock: bigint }> {
  const client = arcPublicClient()
  const addresses = new Set<string>()
  let lastBlock = fromBlock - 1n
  const deadline = Date.now() + SCAN_BUDGET_MS
  for (let lo = fromBlock; lo <= head; lo += TRANSFER_LOG_CHUNK + 1n) {
    if (Date.now() > deadline) break
    const hi = lo + TRANSFER_LOG_CHUNK > head ? head : lo + TRANSFER_LOG_CHUNK
    const logs = await withRateLimitRetry(
      () => client.getLogs({ address: token, event: TRANSFER, fromBlock: lo, toBlock: hi }) as Promise<TransferLog[]>,
    ).catch(() => [] as TransferLog[])
    for (const l of logs) {
      const to = l.args.to as Address
      if (to) addresses.add(to.toLowerCase())
    }
    lastBlock = hi
  }
  return { addresses, lastBlock }
}

async function transferRecipients(token: Address, fromBlock: bigint): Promise<Set<string>> {
  const key = HOLDER_SCAN_KV_KEY(token)
  const cached = await kvGetSafe<HolderScanCache>(key)
  const known = new Set(cached?.addresses ?? [])
  try {
    const client = arcPublicClient()
    const head = await withRateLimitRetry(() => client.getBlockNumber())
    const floor = fromBlock > head ? head : fromBlock
    const resume = cached != null ? BigInt(cached.lastBlock) + 1n : floor
    const startBlock = resume > floor ? resume : floor
    if (startBlock > head) return known
    const { addresses: fresh, lastBlock } = await scanTransferLogsChunked(token, startBlock, head)
    for (const a of fresh) known.add(a)
    if (lastBlock >= startBlock) {
      const entry: HolderScanCache = { addresses: [...known], lastBlock: Number(lastBlock), updatedAt: Date.now() }
      await kvSetSafe(key, entry, HOLDER_SCAN_KV_TTL_S)
    }
  } catch {
    /* getBlockNumber itself failed even after retry — cached/trade-derived addresses still work */
  }
  return known
}


/** OZ ERC20 `_balances[account]` slot. $EVE layout verified 2026-09-02 (slot 2 = 1e9 * 1e18). */
function mappingSlot(key: Address, slot: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [key, slot],
    ),
  )
}

/** Percent with 6 d.p. so 17.6k of 1B (0.00176%) does not integer-round to 0. */
function burnedPctFromRaw(burned: bigint, totalSupply: bigint): number | null {
  if (typeof totalSupply !== 'bigint' || totalSupply === 0n) return null
  return Number((burned * 100_000_000n) / totalSupply) / 1_000_000
}

async function fetchTokenBurnedPctFromStorage(token: Address): Promise<number | null> {
  const client = arcLogsClient()
  try {
    const [supplyRaw, deadRaw, zeroRaw] = await Promise.all([
      client.getStorageAt({ address: token, slot: toHex(2n, { size: 32 }) }),
      client.getStorageAt({ address: token, slot: mappingSlot(DEAD, 0n) }),
      client.getStorageAt({ address: token, slot: mappingSlot(ZERO, 0n) }),
    ])
    const totalSupply = BigInt(supplyRaw ?? '0')
    const burned = BigInt(deadRaw ?? '0') + BigInt(zeroRaw ?? '0')
    return burnedPctFromRaw(burned, totalSupply)
  } catch {
    return null
  }
}

export async function fetchTokenBurnedPct(token: Address): Promise<number | null> {
  // Storage first: Infura eth_call is quota-dead; arc-scan getStorageAt still answers.
  const fromStorage = await fetchTokenBurnedPctFromStorage(token)
  if (fromStorage != null) return fromStorage
  const client = arcPublicClient()
  try {
    const [totalSupply, deadBal, zeroBal] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [DEAD] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO] }),
    ])
    const burned =
      (typeof deadBal === 'bigint' ? deadBal : 0n) + (typeof zeroBal === 'bigint' ? zeroBal : 0n)
    return burnedPctFromRaw(burned, typeof totalSupply === 'bigint' ? totalSupply : 0n)
  } catch {
    return null
  }
}

export async function fetchEvmHolders(
  _chain: 'arc',
  token: Address,
  opts?: {
    creatorAddress?: string
    fromBlock?: bigint
    seedAddresses?: string[]
    excludeAddresses?: string[]
  },
): Promise<EvmHoldersResult> {
  const client = arcPublicClient()
  const factory = ARC.INSTANT_FACTORY
  const creator = (opts?.creatorAddress ?? '').toLowerCase()
  const extraExclude = new Set((opts?.excludeAddresses ?? []).map((a) => a.toLowerCase()).filter(Boolean))
  for (const a of instantProtocolAddresses()) extraExclude.add(a.toLowerCase())
  const skip = (a: string) => isExcludedHolder(a, factory) || extraExclude.has(a)

  const totalSupply = await client
    .readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
    .catch(() => 0n)

  const addresses = new Set<string>()
  for (const a of opts?.seedAddresses ?? []) {
    if (a) addresses.add(a.toLowerCase())
  }
  if (creator) addresses.add(creator)

  const scanFrom = opts?.fromBlock ?? 0n
  const fromTransfers = await transferRecipients(token, scanFrom)
  for (const a of fromTransfers) {
    if (!skip(a)) addresses.add(a)
  }

  const candidates = [...addresses].filter((a) => !skip(a))
  if (!candidates.length) return { total: 0, holders: [] }

  const rows = await mapWithConcurrency(candidates, BALANCE_FANOUT, async (addr) => {
    const bal = await client
      .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [addr as Address] })
      .catch(() => 0n)
    return { address: addr, total: bal, isDev: creator ? addr === creator : false }
  })

  const nonZero = rows
    .filter((r) => r.total > 0n)
    .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0))

  const holders = nonZero.slice(0, 200).map((r, i) => ({
    rank: i + 1,
    address: r.address,
    balance: fmtBalance(r.total),
    percentage: toPercent(r.total, totalSupply > 0n ? totalSupply : 1n),
    isDev: r.isDev,
  }))

  return { total: nonZero.length, holders }
}
