/**
 * Arc holder indexer — maintains a per-token balance ledger incrementally from Transfer events
 * (add to `to`, subtract from `from`), so ranking holders is a KV read, not a live RPC scan.
 *
 * Originally trimmed from Robinpad's `lib/evm-holders.ts` (a live balanceOf poll over a growing
 * set of ever-seen addresses — no persistent balances at all). That shape had two compounding
 * problems, both found live on $EVE 2026-09-03/04:
 *
 *  - No cap on the balanceOf fan-out, so response time scaled with however many addresses the
 *    KV address-set cache had ever accumulated — confirmed 69.5s end to end, growing with use,
 *    not shrinking (fixed short-term by budget-capping the fan-out; see BALANCE_BUDGET_MS below,
 *    now only used for the small bootstrap gap this file's new design leaves).
 *  - `total` was "however many candidates finished resolving before the budget cut off" — a
 *    number that changes every request depending on RPC luck, not the real holder count. Went
 *    127 -> 43 -> 24 -> 22 across four requests with no on-chain change.
 *
 * This version keeps a durable balance for every address a token's Transfer log has ever
 * mentioned, updated by applying each event's delta once. `fetchEvmHolders`'s request-path cost
 * becomes "catch the ledger up by whatever's happened since it was last touched" (small, once
 * warm) instead of "recompute everything live." A background cron (runHoldersLedgerCycle, see
 * app/api/arc/indexer/holders/route.ts) keeps every known token's ledger caught up on its own
 * schedule so a user opening the tab usually finds it already warm.
 */
import { kv } from '@vercel/kv'
import { encodeAbiParameters, erc20Abi, keccak256, parseAbiItem, toHex, type Address, type Log } from 'viem'
import { ARC, arcLogsClient, arcPublicClient, instantProtocolAddresses } from './contracts-arc'
import { withRateLimitRetry } from './rpc-retry'
import { DEFAULT_TOKEN_DECIMALS } from './token-format'
import { getToken, listIndexedTokens } from './arc-indexer/store'
import { summarizeRpcError } from './rpc-error'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
type TransferLog = Log<bigint, number, false, typeof TRANSFER, true> & {
  args: { from?: Address; to?: Address; value?: bigint }
}
const DEAD = '0x000000000000000000000000000000000000dead' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const BALANCE_FANOUT = 8
const TRANSFER_LOG_CHUNK = 9_000n
/** Same floor the rest of the indexer uses (lib/arc-indexer/run.ts, .../indexer/otc/route.ts) —
 *  avoids the "scan from genesis, waste the whole budget on empty pre-launch blocks" bug found
 *  live on a different project this session. Used only when a token's own createdBlock isn't
 *  known yet. */
const CHAIN_FLOOR = 14_000_000n
/** Wall-clock budget for one ledger catch-up call from the live request path — keeps a cold or
 *  far-behind ledger from blocking a page load; the background cron (larger budget, see its own
 *  route) is what actually keeps ledgers caught up in steady state. */
const SCAN_BUDGET_MS = 8_000
/** Budget for resolving seedAddresses (recent traders) the ledger hasn't caught up to yet — a
 *  small bootstrap gap once warm, not the primary balance source it used to be. */
const BALANCE_BUDGET_MS = 15_000
/**
 * Was hardcoded 6 — the exact bug lib/token-format.ts already documents fixing once: this file
 * was "trimmed from Robinpad's lib/evm-holders.ts" (6dp, USDC-style tokens) and never picked up
 * Arc's own 18dp LaunchToken18 convention. Inflated every displayed balance ~1e12x — confirmed
 * live 2026-09-03 on $EVE holders: a real ~15.04M-token (1.5%) position rendered as
 * "15,043,387,475,695,086,000", which also can't possibly fit a mobile row.
 */
const TOKEN_DECIMALS = DEFAULT_TOKEN_DECIMALS

/** Cursor + freshness only — the address set itself now lives in the ledger hash below. */
interface HolderScanMeta {
  lastBlock: number
  updatedAt: number
}
const HOLDER_META_KEY = (token: Address) => `arcfun:holderscan:${token.toLowerCase()}`
/** Redis hash: lowercased address -> decimal balance string, raw units (not human-divided). */
const HOLDER_LEDGER_KEY = (token: Address) => `arcfun:holderledger:${token.toLowerCase()}`
const HOLDER_LOCK_KEY = (token: Address) => `arcfun:holderlock:${token.toLowerCase()}`
const HOLDER_KV_TTL_S = 30 * 24 * 60 * 60
/** One ledger update per token at a time — background cron and a live page load can otherwise
 *  race the same hash the same way the OTC cursor race (fixed in #124) did. Best-effort dedup,
 *  not correctness-critical: losing the race just means this call skips a tick, the ledger is
 *  never written from two places at once. */
const HOLDER_LOCK_TTL_S = 25

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
async function claimHolderLock(token: Address): Promise<boolean> {
  try {
    const res = await kv.set(HOLDER_LOCK_KEY(token), Date.now(), { ex: HOLDER_LOCK_TTL_S, nx: true })
    return res === 'OK'
  } catch {
    return false
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

/**
 * Scans [fromBlock, head] for Transfer logs, applying each one's delta to the ledger hash as it
 * goes: read the current balance of every address touched in a chunk (one hmget), apply that
 * chunk's deltas in event order, write back only what changed (one hset) — never a full-hash
 * read or write, so cost scales with activity in the scanned range, not with total holder count.
 * Bounded by budgetMs the same way the rest of this indexer bounds chunked scans; returns
 * however far it actually got so the caller can persist a resumable cursor.
 */
async function applyTransferDeltas(
  token: Address,
  fromBlock: bigint,
  head: bigint,
  budgetMs: number,
): Promise<{ lastBlock: bigint; touched: number; chunksScanned: number }> {
  const client = arcLogsClient()
  const ledgerKey = HOLDER_LEDGER_KEY(token)
  const deadline = Date.now() + budgetMs
  let lastBlock = fromBlock - 1n
  let touched = 0
  let chunksScanned = 0
  for (let lo = fromBlock; lo <= head; lo += TRANSFER_LOG_CHUNK + 1n) {
    if (Date.now() > deadline) break
    const hi = lo + TRANSFER_LOG_CHUNK > head ? head : lo + TRANSFER_LOG_CHUNK
    const logs = await withRateLimitRetry(
      () => client.getLogs({ address: token, event: TRANSFER, fromBlock: lo, toBlock: hi }) as Promise<TransferLog[]>,
    ).catch(() => [] as TransferLog[])
    chunksScanned++
    if (logs.length) {
      const touchedAddrs = new Set<string>()
      for (const l of logs) {
        if (l.args.from) touchedAddrs.add(l.args.from.toLowerCase())
        if (l.args.to) touchedAddrs.add(l.args.to.toLowerCase())
      }
      touchedAddrs.delete(ZERO.toLowerCase()) // mint/burn counterpart — never a real balance to track
      const addrList = [...touchedAddrs]
      let current: Record<string, string> | null = null
      if (addrList.length) {
        try {
          current = await kv.hmget<Record<string, string>>(ledgerKey, ...addrList)
        } catch (e) {
          console.warn('[evm-holders] hmget', token, summarizeRpcError(e))
        }
      }
      const balances = new Map<string, bigint>()
      for (const a of addrList) {
        const raw = current?.[a]
        balances.set(a, raw ? BigInt(raw) : 0n)
      }
      for (const l of logs) {
        const value = l.args.value ?? 0n
        const from = l.args.from?.toLowerCase()
        const to = l.args.to?.toLowerCase()
        if (from && from !== ZERO.toLowerCase()) {
          const b = balances.get(from) ?? 0n
          // Clamped, never negative — a ledger gap (cold start mid-history, a dropped chunk)
          // should degrade to "unknown/zero" rather than an impossible negative balance.
          balances.set(from, b > value ? b - value : 0n)
        }
        if (to && to !== ZERO.toLowerCase()) {
          balances.set(to, (balances.get(to) ?? 0n) + value)
        }
      }
      if (balances.size) {
        const updates: Record<string, string> = {}
        for (const [addr, bal] of balances) updates[addr] = bal.toString()
        try {
          await kv.hset(ledgerKey, updates)
          await kv.expire(ledgerKey, HOLDER_KV_TTL_S)
          touched += Object.keys(updates).length
        } catch (e) {
          console.warn('[evm-holders] hset', token, summarizeRpcError(e))
        }
      }
    }
    lastBlock = hi
  }
  return { lastBlock, touched, chunksScanned }
}

/**
 * Finds a much tighter starting block than CHAIN_FLOOR for a token whose own createdBlock isn't
 * known — confirmed live 2026-09-04 on $EVE: a ground-truth Transfer scan from CHAIN_FLOOR found
 * ZERO logs across the first 1,080,000 blocks (two full 60-chunk rounds) before this fix — the
 * token simply didn't exist yet across that whole range. At the ledger's real per-tick pace
 * (budget-bounded, one token touched roughly every few cron rotations) that's not "still catching
 * up," it's "might never realistically reach real activity."
 *
 * Prefers createdBlock when the token registry has it (cheap, exact). Falls back to a binary
 * search over block timestamps against createdAt (which this route call always has, even when
 * createdBlock doesn't) — bounded to ~log2(head) probes, a one-time cost paid only when a token
 * has no ledger cursor yet, never on a resumed scan.
 */
async function findFloorBlock(
  token: Address,
  client: ReturnType<typeof arcPublicClient>,
  head: bigint,
): Promise<bigint> {
  try {
    const info = await getToken(token)
    if (info?.createdBlock != null && info.createdBlock > 0) {
      return BigInt(Math.max(0, info.createdBlock - 100))
    }
    if (info?.createdAt != null && info.createdAt > 0) {
      const targetTs = BigInt(info.createdAt)
      let lo = 0n
      let hi = head
      while (lo < hi) {
        const mid = (lo + hi) / 2n
        const block = await withRateLimitRetry(() => client.getBlock({ blockNumber: mid })).catch(() => null)
        // A probe that fails even after retry: search the earlier half rather than guess — worst
        // case this makes the floor a bit more conservative (more blocks scanned), never wrong
        // in the dangerous direction (skipping real activity).
        if (!block || block.timestamp >= targetTs) hi = mid
        else lo = mid + 1n
      }
      return lo > 200n ? lo - 200n : 0n
    }
  } catch (e) {
    console.warn('[evm-holders] findFloorBlock', token, summarizeRpcError(e))
  }
  return CHAIN_FLOOR
}

/**
 * Catches one token's ledger up to (near) head, resuming from its saved cursor. Safe to call
 * from both the live request path (small budgetMs) and the background cron (larger budgetMs) —
 * claimHolderLock keeps the two from racing the same token's hash concurrently.
 */
export async function updateHolderLedger(
  token: Address,
  opts?: { budgetMs?: number; floorBlock?: bigint },
): Promise<{ ok: boolean; scannedTo?: bigint; touched?: number }> {
  const got = await claimHolderLock(token)
  if (!got) return { ok: false }
  try {
    const client = arcPublicClient()
    const head = await withRateLimitRetry(() => client.getBlockNumber())
    const meta = await kvGetSafe<HolderScanMeta>(HOLDER_META_KEY(token))
    // findFloorBlock only runs when there's no cursor yet (meta is null) — once a cursor exists,
    // `resume` below is always past any reasonable floor, so this stays a one-time cost.
    const floor = opts?.floorBlock ?? (meta ? CHAIN_FLOOR : await findFloorBlock(token, client, head))
    const resume = meta ? BigInt(meta.lastBlock) + 1n : floor
    const startBlock = resume > floor ? resume : floor
    if (startBlock > head) return { ok: true, scannedTo: head, touched: 0 }
    const { lastBlock, touched } = await applyTransferDeltas(
      token,
      startBlock,
      head,
      opts?.budgetMs ?? SCAN_BUDGET_MS,
    )
    if (lastBlock >= startBlock) {
      await kvSetSafe(HOLDER_META_KEY(token), { lastBlock: Number(lastBlock), updatedAt: Date.now() }, HOLDER_KV_TTL_S)
    }
    return { ok: true, scannedTo: lastBlock, touched }
  } catch (e) {
    console.warn('[evm-holders] updateHolderLedger', token, summarizeRpcError(e))
    return { ok: false }
  }
}

/** Full ledger for one token as address -> balance. Zero-balance entries are skipped: a token
 *  with any real transfer history accumulates plenty of them (every address that ever fully
 *  sold out stays a hash field at "0"), and no caller of this function wants those. */
async function readHolderLedger(token: Address): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  try {
    const raw = await kv.hgetall<Record<string, string>>(HOLDER_LEDGER_KEY(token))
    if (raw) {
      for (const [addr, bal] of Object.entries(raw)) {
        const b = BigInt(bal || '0')
        if (b > 0n) out.set(addr, b)
      }
    }
  } catch (e) {
    console.warn('[evm-holders] hgetall', token, summarizeRpcError(e))
  }
  return out
}

/** Resolves balanceOf for `candidates` at BALANCE_FANOUT concurrency, stopping once budgetMs
 *  elapses. Only ever called now for the bootstrap gap — seedAddresses the ledger hasn't caught
 *  up to yet — so candidates is typically small once a token's ledger is warm. The deadline is
 *  checked before starting each new lookup, not mid-flight (viem's readContract has no cheap
 *  cancellation), so worst case this can still run ~one call's latency past the budget. */
async function fetchBalancesBounded(
  candidates: string[],
  token: Address,
  client: ReturnType<typeof arcPublicClient>,
  budgetMs: number,
): Promise<Map<string, bigint>> {
  const deadline = Date.now() + budgetMs
  const results = new Map<string, bigint>()
  let nextIndex = 0
  const limit = Math.max(1, Math.min(BALANCE_FANOUT, candidates.length))
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      if (Date.now() > deadline) return
      const i = nextIndex++
      if (i >= candidates.length) return
      const addr = candidates[i]
      const bal = await client
        .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [addr as Address] })
        .catch(() => 0n)
      results.set(addr, bal)
    }
  })
  await Promise.all(workers)
  return results
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

  // Catch the ledger up (small budget from this path — the background cron carries the real
  // weight) and read totalSupply concurrently; neither depends on the other.
  const [, totalSupply] = await Promise.all([
    updateHolderLedger(token, { budgetMs: SCAN_BUDGET_MS, floorBlock: opts?.fromBlock }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => 0n),
  ])

  const ledger = await readHolderLedger(token)

  // Bootstrap gap: seedAddresses (recent traders) the ledger hasn't caught up to yet. Once a
  // token's ledger is warm this is typically a handful of addresses, not the whole candidate
  // set it used to be.
  const missing = [...new Set((opts?.seedAddresses ?? []).map((a) => a.toLowerCase()).filter(Boolean))].filter(
    (a) => !ledger.has(a) && !skip(a),
  )
  if (missing.length) {
    const resolved = await fetchBalancesBounded(missing, token, client, BALANCE_BUDGET_MS)
    const persist: Record<string, string> = {}
    for (const [addr, bal] of resolved) {
      if (bal > 0n) {
        ledger.set(addr, bal)
        persist[addr] = bal.toString()
      }
    }
    if (Object.keys(persist).length) {
      try {
        await kv.hset(HOLDER_LEDGER_KEY(token), persist)
        await kv.expire(HOLDER_LEDGER_KEY(token), HOLDER_KV_TTL_S)
      } catch {
        /* best-effort — still served from the in-memory ledger this request either way */
      }
    }
  }

  if (creator && !ledger.has(creator) && !skip(creator)) {
    const bal = await client
      .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [creator as Address] })
      .catch(() => 0n)
    if (bal > 0n) ledger.set(creator, bal)
  }

  const nonZero = [...ledger.entries()]
    .filter(([addr, bal]) => bal > 0n && !skip(addr))
    .map(([address, total]) => ({ address, total, isDev: creator ? address === creator : false }))
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

/**
 * Background maintenance: keeps every known token's holder ledger caught up. Round-robins over
 * listIndexedTokens() the same registry catchUpSwapsAndVolume already uses — any token the
 * platform knows about gets a maintained ledger, no separate registry to keep in sync. Meant to
 * be called from its own cron tick (app/api/arc/indexer/holders/route.ts), independent of the
 * factory/swap cycle and of Jessica's existing load — see that route's own comment for why.
 */
export async function runHoldersLedgerCycle(opts?: {
  batchSize?: number
  perTokenBudgetMs?: number
}): Promise<{ tokens: number; touched: number; ok: boolean }> {
  const batchSize = opts?.batchSize ?? 10
  const perTokenBudgetMs = opts?.perTokenBudgetMs ?? 20_000
  try {
    const all = await listIndexedTokens()
    if (!all.length) return { tokens: 0, touched: 0, ok: true }
    // Round-robin by createdAt so every token gets a turn over successive ticks rather than
    // always racing the same handful at the front of the registry.
    const start = Math.floor(Date.now() / 60_000) % all.length
    const batch = Array.from({ length: Math.min(batchSize, all.length) }, (_, i) => all[(start + i) % all.length])

    let touched = 0
    for (const t of batch) {
      const floorBlock = t.createdBlock != null ? BigInt(t.createdBlock) : undefined
      const res = await updateHolderLedger(t.token as Address, { budgetMs: perTokenBudgetMs, floorBlock })
      touched += res.touched ?? 0
    }
    return { tokens: batch.length, touched, ok: true }
  } catch (e) {
    console.warn('[evm-holders] runHoldersLedgerCycle', summarizeRpcError(e))
    return { tokens: 0, touched: 0, ok: false }
  }
}
