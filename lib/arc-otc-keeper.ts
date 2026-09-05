/**
 * Arc OTC desk keeper — settles Instant OTC fills (Base/ARB/ETH → Arc).
 * Live ticks run on Jessica's Air (lib/arc-indexer/daemon.ts). The HTTP route is a manual trigger.
 *
 * Flow per fill (v4 payment = reserve + lock):
 *   1. lock() on payment (blocks self-refund) BEFORE Arc
 *   2. deliver(..., reservationId) on Arc liquidity — must succeed on-chain
 *   3. settle() on payment ONLY if Arc delivered[fillId] is true
 *
 * Hardening (2026-08-12, after live loss path: deliver reverted `expired` but settle still ran):
 *   - NEVER settle unless Arc delivered[] is true (re-read after deliver tx)
 *   - Reject deliver receipts with status !== success (old code treated any mined hash as success)
 *   - Receipt timeouts (no infinite hang past reservation TTL)
 *   - Chunked getLogs ≤9k (Base public RPC limit)
 *   - Pre-check reservation expiry; unlock for refund instead of settle
 *   - Simulate deliver when possible
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet } from 'viem/chains'
import { arcPublicClient, arcServerWalletClient, ARC_CHAIN_ID } from './contracts-arc'
import { ROBIN_OTC_LIQUIDITY } from './bridge/robin-otc'
import { listOtcReservations, removeOtcReservation } from './arc-indexer/store'

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

export type OtcKeeperTickResult = {
  spoke: string
  fillId: string
  action: 'skip' | 'locked' | 'delivered' | 'settled' | 'released' | 'error'
  detail?: string
  txHash?: string
}

type PaymentSpoke = {
  id: string
  chain: Chain
  rpc: string
  payment: Address
}

const ZERO = '0x0000000000000000000000000000000000000000'
function envAddr(...keys: string[]): Address | null {
  for (const k of keys) {
    const v = (process.env[k] || '').trim().replace(/[\r\n]+/g, '')
    if (v && v.toLowerCase() !== ZERO) return v as Address
  }
  return null
}

/** Same defaults as lib/bridge/robin-otc.ts's OTC_DEFAULTS — the live shared contracts. */
const DEFAULT_PAYMENT_BASE = '0xac79DD3FE3C0cCD1ba91c925697b8A8fec1E9Bcb' as Address
const DEFAULT_PAYMENT_ARB = '0xc476968FB376b9f1Bc4011De3EFA6d466a765B4B' as Address

function loadPaymentSpokes(): PaymentSpoke[] {
  const list: PaymentSpoke[] = [
    {
      id: 'eth',
      chain: mainnet,
      rpc: process.env.ETH_RPC || process.env.NEXT_PUBLIC_ETH_RPC || 'https://ethereum.publicnode.com',
      payment: envAddr(
        'ROBIN_OTC_PAYMENT_ETH',
        'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ETH',
        'ROBIN_OTC_PAYMENT_ESCROW',
        'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ESCROW',
      ) as Address,
    },
    {
      id: 'base',
      chain: base,
      rpc: process.env.BASE_RPC || process.env.NEXT_PUBLIC_BASE_RPC || 'https://mainnet.base.org',
      payment: (envAddr('ROBIN_OTC_PAYMENT_BASE', 'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_BASE') ??
        DEFAULT_PAYMENT_BASE) as Address,
    },
    {
      id: 'arb',
      chain: arbitrum,
      rpc:
        process.env.ARB_RPC ||
        process.env.NEXT_PUBLIC_ARB_RPC ||
        process.env.NEXT_PUBLIC_ARBITRUM_RPC ||
        'https://arb1.arbitrum.io/rpc',
      payment: (envAddr('ROBIN_OTC_PAYMENT_ARB', 'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ARB') ??
        DEFAULT_PAYMENT_ARB) as Address,
    },
  ]
  return list.filter((s) => !!s.payment)
}

const FILL_STATUS = { None: 0, Pending: 1, Locked: 2, Settled: 3, Refunded: 4 } as const

const paymentAbi = [
  {
    type: 'function',
    name: 'fills',
    stateMutability: 'view',
    inputs: [{ name: 'fillId', type: 'bytes32' }],
    outputs: [
      { name: 'buyer', type: 'address' },
      { name: 'offerId', type: 'bytes32' },
      { name: 'destAmount', type: 'uint256' },
      { name: 'destRecipient', type: 'address' },
      { name: 'sellerPayment', type: 'address' },
      { name: 'premiumBps', type: 'uint32' },
      { name: 'sellerProceeds', type: 'uint256' },
      { name: 'serviceFee', type: 'uint256' },
      { name: 'createdAt', type: 'uint64' },
      { name: 'status', type: 'uint8' },
      { name: 'reservationId', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'lock',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fillId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'unlock',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fillId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fillId', type: 'bytes32' }],
    outputs: [],
  },
] as const

const liquidityAbi = [
  {
    type: 'function',
    name: 'delivered',
    stateMutability: 'view',
    inputs: [{ name: 'fillId', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'reservations',
    stateMutability: 'view',
    inputs: [{ name: 'reservationId', type: 'bytes32' }],
    outputs: [
      { name: 'offerId', type: 'bytes32' },
      { name: 'reserver', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'consumed', type: 'bool' },
      { name: 'released', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'deliver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'offerId', type: 'bytes32' },
      { name: 'fillId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'sellerPayment', type: 'address' },
      { name: 'premiumBps', type: 'uint32' },
      { name: 'reservationId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    // Per RobinOtcLiquidity.sol: "Reserver anytime; anyone after expiry." — the keeper wallet
    // needs no special role to call this, same as any wallet would.
    type: 'function',
    name: 'releaseReservation',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'reservationId', type: 'bytes32' }],
    outputs: [],
  },
] as const

const fillCreatedEvent = parseAbiItem(
  'event FillCreated(bytes32 indexed fillId, address indexed buyer, bytes32 indexed offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, uint256 sellerProceeds, uint256 serviceFee, bytes32 reservationId)',
)

const LOG_CHUNK = 9_000n
const MAX_LOOKBACK = 9_000n
const RECEIPT_TIMEOUT_MS = 90_000
const RPC_HTTP_TIMEOUT_MS = 25_000

async function waitReceipt(client: PublicClient, hash: Hex, label: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: RECEIPT_TIMEOUT_MS,
    pollingInterval: 2_000,
  })
  if (receipt.status !== 'success') {
    // Include the on-chain revert reason when the RPC node returns one (Arc's does — confirmed
    // live 2026-09-05 on a releaseReservation revert: revertReason "done"). Every "done"/"not
    // allowed" detection in this file (safeReleaseReservation, sweepKnownOrphanReservations,
    // sweepIndexedReservations) pattern-matches the THROWN error message expecting exactly this
    // string — but releaseReservation/unlock/settle are never simulated before being broadcast
    // (unlike deliver, which does call simulateContract first), so a doomed call always reaches
    // this branch with only "tx reverted: <hash>" and no reason. That made the "done" checks
    // dead code for anything discovered post-broadcast: a reservation already released before the
    // sweep ran reverted "done" every single tick, forever, instead of being recognized as the
    // expected steady state and skipped — see KNOWN_ORPHAN_RESERVATIONS below, both of whose
    // entries turned out to already be released and had been silently re-reverting on ~60s
    // cadence indefinitely.
    const reason = (receipt as { revertReason?: string }).revertReason
    throw new Error(`${label} tx reverted: ${hash}${reason ? ` (${reason})` : ''}`)
  }
}

export async function runOtcKeeperTick(opts?: {
  lookbackBlocks?: bigint
  dryRun?: boolean
}): Promise<{
  ok: boolean
  keeper?: string
  liquidity?: string
  spokes: string[]
  results: OtcKeeperTickResult[]
  error?: string
}> {
  const rawLookback = opts?.lookbackBlocks ?? 8_000n
  const lookback = rawLookback > MAX_LOOKBACK ? MAX_LOOKBACK : rawLookback
  const dryRun = opts?.dryRun === true

  const pk = (process.env.ARC_OTC_KEEPER_KEY || process.env.ROBIN_OTC_KEEPER_KEY || '').trim()
  const spokes = loadPaymentSpokes()

  if (!pk) return { ok: false, spokes: [], results: [], error: 'ARC_OTC_KEEPER_KEY / ROBIN_OTC_KEEPER_KEY missing' }
  if (!ROBIN_OTC_LIQUIDITY || ROBIN_OTC_LIQUIDITY === ZERO) {
    return { ok: false, spokes: [], results: [], error: 'liquidity escrow missing' }
  }
  if (spokes.length === 0) return { ok: false, spokes: [], results: [], error: 'no payment spokes configured' }

  const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
  const account = privateKeyToAccount(key)

  const arcPub = arcPublicClient()
  const arcWallet = arcServerWalletClient(key)
  const liquidity = ROBIN_OTC_LIQUIDITY

  const results: OtcKeeperTickResult[] = []

  for (const spoke of spokes) {
    try {
      const spokeHttp = http(spoke.rpc, { timeout: RPC_HTTP_TIMEOUT_MS })
      const pub = createPublicClient({
        chain: spoke.chain,
        transport: spokeHttp,
      }) as PublicClient
      const wallet = createWalletClient({
        account,
        chain: spoke.chain,
        transport: spokeHttp,
      }) as WalletClient

      const latest = await pub.getBlockNumber()
      const from = latest > lookback ? latest - lookback : 0n
      const logs: Awaited<ReturnType<typeof pub.getLogs>> = []
      for (let cursor = from; cursor <= latest; ) {
        const to = cursor + LOG_CHUNK - 1n > latest ? latest : cursor + LOG_CHUNK - 1n
        try {
          const part = await pub.getLogs({
            address: spoke.payment,
            event: fillCreatedEvent,
            fromBlock: cursor,
            toBlock: to,
          })
          logs.push(...part)
        } catch (logErr) {
          results.push({
            spoke: spoke.id,
            fillId: '',
            action: 'error',
            detail: `getLogs ${cursor}-${to}: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
          })
        }
        if (to === latest) break
        cursor = to + 1n
      }

      for (const log of logs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fillId = (log as any).args?.fillId as Hex | undefined
        if (!fillId) continue

        try {
          const fill = await pub.readContract({
            address: spoke.payment,
            abi: paymentAbi,
            functionName: 'fills',
            args: [fillId],
          })
          const status = Number(fill[9])
          const reservationId = fill[10] as Hex

          const arcDelivered = async (): Promise<boolean> => {
            try {
              return await arcPub.readContract({
                address: liquidity,
                abi: liquidityAbi,
                functionName: 'delivered',
                args: [fillId],
              })
            } catch {
              return false
            }
          }

          /**
           * Recover the maker's Arc liquidity from a reservation that can never be delivered
           * against — either because it already expired, or because the payment side is done
           * (Settled/Refunded) and no further deliver() attempt will ever happen for this fillId.
           * releaseReservation() needs no special role once expired ("Reserver anytime; anyone
           * after expiry" — RobinOtcLiquidity.sol) and is a no-op-safe call: it reverts harmlessly
           * if the reservation is already consumed/released, which safeReleaseReservation treats
           * as success rather than an error.
           *
           * Found live 2026-08-12: two real fills (0x1e47a8e7…, 0x13ae3cd3…) reached Settled with
           * delivered()==false — the old code path skipped Settled fills outright (never checked
           * their reservation at all), so 2.0 USDC of maker liquidity sat locked indefinitely with
           * nothing ever recovering it. This closes that gap for both the already-terminal case
           * (checked below, before the status skip) and the in-flight case (called from the
           * reservationExpired branches further down, so a fill that expires mid-flight gets its
           * reservation released in the same tick its payment side gets unlocked for refund).
           */
          const safeReleaseReservation = async (reason: string) => {
            if (!reservationId || reservationId.toLowerCase() === ZERO_BYTES32) return
            if (dryRun) {
              results.push({ spoke: spoke.id, fillId, action: 'released', detail: `dry-run: ${reason}` })
              return
            }
            try {
              const hash = await arcWallet.writeContract({
                account,
                chain: arcWallet.chain,
                address: liquidity,
                abi: liquidityAbi,
                functionName: 'releaseReservation',
                args: [reservationId],
                gas: 120_000n,
              })
              await waitReceipt(arcPub as PublicClient, hash, 'releaseReservation')
              results.push({ spoke: spoke.id, fillId, action: 'released', detail: reason, txHash: hash })
            } catch (relErr) {
              const relMsg = relErr instanceof Error ? relErr.message : String(relErr)
              // "done" (already consumed/released) or "not allowed" (not yet expired) are expected
              // outcomes of a permissionless sweep racing another caller or the TTL — not failures.
              if (/done|not allowed/i.test(relMsg)) return
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'error',
                detail: `${reason} — releaseReservation failed: ${relMsg.slice(0, 160)}`,
              })
            }
          }

          if (status === FILL_STATUS.Settled || status === FILL_STATUS.Refunded) {
            // Settled-without-delivery is the dangerous case this fix targets — sweep it before
            // skipping. Refunded fills never reserved successfully consumed inventory either way,
            // but check the same path since it costs one extra read, not a new code path.
            if (status === FILL_STATUS.Settled && reservationId && reservationId.toLowerCase() !== ZERO_BYTES32) {
              const delivered = await arcDelivered()
              if (!delivered) {
                await safeReleaseReservation(`status=Settled but Arc delivered=false — recovering stale reservation`)
              }
            }
            results.push({ spoke: spoke.id, fillId, action: 'skip', detail: `status=${status}` })
            continue
          }
          if (status !== FILL_STATUS.Pending && status !== FILL_STATUS.Locked) {
            results.push({ spoke: spoke.id, fillId, action: 'skip', detail: `status=${status}` })
            continue
          }

          const offerId = fill[1] as Hex
          const destAmount = fill[2] as bigint
          const destRecipient = fill[3] as Address
          const sellerPayment = fill[4] as Address
          const premiumBps = Number(fill[5])
          if (!reservationId || reservationId.toLowerCase() === ZERO_BYTES32) {
            results.push({
              spoke: spoke.id,
              fillId,
              action: 'error',
              detail: 'fill missing reservationId (old payment contract?)',
            })
            continue
          }

          const safeUnlock = async (reason: string) => {
            try {
              const unlockHash = await wallet.writeContract({
                account,
                chain: spoke.chain,
                address: spoke.payment,
                abi: paymentAbi,
                functionName: 'unlock',
                args: [fillId],
                gas: 100_000n,
              })
              await waitReceipt(pub, unlockHash, 'unlock')
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'error',
                detail: `${reason} — unlocked for buyer refund`,
                txHash: unlockHash,
              })
            } catch (unlockErr) {
              const unlockMsg = unlockErr instanceof Error ? unlockErr.message : String(unlockErr)
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'error',
                detail: `${reason} — unlock FAILED (stuck Locked): ${unlockMsg}`,
              })
            }
          }

          // Pre-check Arc reservation expiry before locking/delivering
          let reservationExpired = false
          try {
            const r = await arcPub.readContract({
              address: liquidity,
              abi: liquidityAbi,
              functionName: 'reservations',
              args: [reservationId],
            })
            const expiresAt = Number(
              (r as { expiresAt?: bigint | number }).expiresAt ?? (Array.isArray(r) ? r[3] : 0),
            )
            const consumed = Boolean(
              (r as { consumed?: boolean }).consumed ?? (Array.isArray(r) ? r[4] : false),
            )
            const released = Boolean(
              (r as { released?: boolean }).released ?? (Array.isArray(r) ? r[5] : false),
            )
            const now = Math.floor(Date.now() / 1000)
            if (released || consumed || (expiresAt > 0 && now >= expiresAt)) {
              reservationExpired = true
            }
          } catch {
            /* continue; deliver will revert if bad */
          }

          if (reservationExpired) {
            if (await arcDelivered()) {
              // fall through to settle gate
            } else if (status === FILL_STATUS.Locked && !dryRun) {
              await safeUnlock('reservation expired on Arc before deliver')
              await safeReleaseReservation('reservation expired on Arc before deliver')
              continue
            } else {
              await safeReleaseReservation('reservation expired on Arc — buyer can refund after delay')
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'error',
                detail: 'reservation expired on Arc — NOT settling; buyer can refund after delay',
              })
              continue
            }
          }

          // 1) lock BEFORE Arc
          if (status === FILL_STATUS.Pending) {
            if (dryRun) {
              results.push({ spoke: spoke.id, fillId, action: 'locked', detail: 'dry-run lock' })
            } else {
              const lockHash = await wallet.writeContract({
                account,
                chain: spoke.chain,
                address: spoke.payment,
                abi: paymentAbi,
                functionName: 'lock',
                args: [fillId],
                gas: 100_000n,
              })
              await waitReceipt(pub, lockHash, 'lock')
              results.push({ spoke: spoke.id, fillId, action: 'locked', txHash: lockHash })
            }
          }

          // 2) Arc deliver
          let already = await arcDelivered()

          if (!already) {
            if (dryRun) {
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'delivered',
                detail: `dry-run deliver amount=${destAmount}`,
              })
              continue
            }
            try {
              try {
                await arcPub.simulateContract({
                  account,
                  address: liquidity,
                  abi: liquidityAbi,
                  functionName: 'deliver',
                  args: [
                    offerId,
                    fillId,
                    destAmount,
                    destRecipient,
                    sellerPayment,
                    premiumBps,
                    reservationId,
                  ],
                })
              } catch (simErr) {
                const simMsg = simErr instanceof Error ? simErr.message : String(simErr)
                if (/expired|released|reservation/i.test(simMsg)) {
                  await safeUnlock(`deliver would revert: ${simMsg.slice(0, 160)}`)
                  await safeReleaseReservation(`deliver would revert: ${simMsg.slice(0, 160)}`)
                  continue
                }
              }

              const hash = await arcWallet.writeContract({
                account,
                chain: arcWallet.chain,
                address: liquidity,
                abi: liquidityAbi,
                functionName: 'deliver',
                args: [
                  offerId,
                  fillId,
                  destAmount,
                  destRecipient,
                  sellerPayment,
                  premiumBps,
                  reservationId,
                ],
                gas: 300_000n,
              })
              await waitReceipt(arcPub as PublicClient, hash, 'deliver')
              already = await arcDelivered()
              if (!already) {
                // CRITICAL: old bug was setting already=true after any receipt without status check
                await safeUnlock('deliver tx mined but delivered[] still false (or reverted)')
                await safeReleaseReservation('deliver tx mined but delivered[] still false (or reverted)')
                continue
              }
              results.push({ spoke: spoke.id, fillId, action: 'delivered', txHash: hash })
            } catch (deliverErr) {
              const deliverMsg =
                deliverErr instanceof Error ? deliverErr.message : String(deliverErr)
              const arcPaid = await arcDelivered()
              if (arcPaid) {
                results.push({
                  spoke: spoke.id,
                  fillId,
                  action: 'error',
                  detail: `deliver error but Arc delivered=true — will settle: ${deliverMsg.slice(0, 120)}`,
                })
                already = true
              } else {
                await safeUnlock(`deliver failed: ${deliverMsg.slice(0, 200)}`)
                await safeReleaseReservation(`deliver failed: ${deliverMsg.slice(0, 200)}`)
                continue
              }
            }
          }

          // 3) SETTLE — hard gate: Arc must show delivered
          const paidOnArc = already || (await arcDelivered())
          if (!paidOnArc) {
            results.push({
              spoke: spoke.id,
              fillId,
              action: 'error',
              detail: 'REFUSING settle — Arc delivered=false (would pay maker without buyer Arc USDC)',
            })
            continue
          }

          if (dryRun) {
            results.push({ spoke: spoke.id, fillId, action: 'settled', detail: 'dry-run settle' })
            continue
          }

          const sh = await wallet.writeContract({
            account,
            chain: spoke.chain,
            address: spoke.payment,
            abi: paymentAbi,
            functionName: 'settle',
            args: [fillId],
            gas: 200_000n,
          })
          await waitReceipt(pub, sh, 'settle')
          results.push({ spoke: spoke.id, fillId, action: 'settled', txHash: sh })
        } catch (e) {
          results.push({
            spoke: spoke.id,
            fillId,
            action: 'error',
            detail: e instanceof Error ? e.message : String(e),
          })
        }
      }
    } catch (e) {
      results.push({
        spoke: spoke.id,
        fillId: '',
        action: 'error',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await sweepKnownOrphanReservations(arcPub, arcWallet, account, liquidity, dryRun, results)
  await sweepIndexedReservations(arcPub, arcWallet, account, liquidity, dryRun, results)

  return {
    ok: true,
    keeper: account.address,
    liquidity,
    spokes: spokes.map((s) => s.id),
    results,
  }
}

/**
 * Stopgap for reservations that `reserve()`d Arc inventory but never got as far as a mined
 * `FillCreated` on the payment chain (e.g. the buyer's fillOffer reverted — out of gas, or any
 * other pre-emit revert). The main sweep above only discovers stale reservations by walking
 * FillCreated logs backward from a fillId, so an orphan like this is invisible to it — there is
 * no event to key off. The durable fix is scanning Arc's own `Reserved` events directly, but Arc's
 * public RPC has no working `eth_getLogs` path right now (baracat down, its only fallback has
 * getLogs disabled) so that scan can't be built or verified against live data yet.
 *
 * In the meantime this is a manually-curated list of specific reservationIds already confirmed
 * on-chain (via direct `reservations()` reads) to be reserved, unconsumed, unreleased. Safe to
 * over-list: releaseReservation() reverts harmlessly on anything already consumed/released or not
 * yet expired — in principle. In practice `waitReceipt`'s "done"/"not allowed" detection couldn't
 * actually catch that revert (see its comment — the thrown message never included the on-chain
 * revert reason until 2026-09-05), so an entry left here past its actual release date wasn't a
 * harmless no-op tick after tick, it was a real reverting transaction on ~60s cadence indefinitely.
 * Remove an entry once it shows `released: true` on-chain — this list is not meant to grow into a
 * real index.
 *
 * 2026-09-05: confirmed both entries below (0x9a9978c0…db201 and 0x4b13c857…d57989) already show
 * released: true on-chain — the first had been reverting "done" on every tick since some point
 * after 2026-08-12, silently burning real gas each time. Cleared. Add a fresh entry here only for
 * a genuinely still-unreleased orphan, confirmed via a live `reservations()` read first.
 */
const KNOWN_ORPHAN_RESERVATIONS: readonly Hex[] = []

async function sweepKnownOrphanReservations(
  arcPub: ReturnType<typeof arcPublicClient>,
  arcWallet: ReturnType<typeof arcServerWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  liquidity: Address,
  dryRun: boolean,
  results: OtcKeeperTickResult[],
) {
  for (const reservationId of KNOWN_ORPHAN_RESERVATIONS) {
    if (dryRun) {
      results.push({
        spoke: 'arc',
        fillId: reservationId,
        action: 'released',
        detail: 'dry-run: known-orphan sweep',
      })
      continue
    }
    try {
      const hash = await arcWallet.writeContract({
        account,
        chain: arcWallet.chain,
        address: liquidity,
        abi: liquidityAbi,
        functionName: 'releaseReservation',
        args: [reservationId],
        gas: 120_000n,
      })
      await waitReceipt(arcPub as PublicClient, hash, 'releaseReservation')
      results.push({
        spoke: 'arc',
        fillId: reservationId,
        action: 'released',
        detail: 'known-orphan sweep',
        txHash: hash,
      })
    } catch (relErr) {
      const relMsg = relErr instanceof Error ? relErr.message : String(relErr)
      // "done" = already recovered (expected steady state once this succeeds once) — not an error.
      if (/done/i.test(relMsg)) continue
      results.push({
        spoke: 'arc',
        fillId: reservationId,
        action: 'error',
        detail: `known-orphan sweep failed: ${relMsg.slice(0, 160)}`,
      })
    }
  }
}

async function sweepIndexedReservations(
  arcPub: ReturnType<typeof arcPublicClient>,
  arcWallet: ReturnType<typeof arcServerWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  liquidity: Address,
  dryRun: boolean,
  results: OtcKeeperTickResult[],
) {
  const rows = await listOtcReservations().catch(() => [])
  const now = Math.floor(Date.now() / 1000)
  for (const row of rows) {
    const reservationId = row.reservationId
    try {
      const onchain = (await arcPub.readContract({
        address: liquidity,
        abi: liquidityAbi,
        functionName: 'reservations',
        args: [reservationId],
      })) as readonly [Hex, Address, bigint, bigint, boolean, boolean]
      const [, , , expiresAt, consumed, released] = onchain
      if (consumed || released) {
        await removeOtcReservation(reservationId)
        continue
      }
      if (Number(expiresAt) > now) continue
      if (dryRun) {
        results.push({
          spoke: 'arc',
          fillId: reservationId,
          action: 'released',
          detail: 'dry-run: kv reservation expired',
        })
        continue
      }
      const hash = await arcWallet.writeContract({
        account,
        chain: arcWallet.chain,
        address: liquidity,
        abi: liquidityAbi,
        functionName: 'releaseReservation',
        args: [reservationId],
        gas: 150_000n,
      })
      await waitReceipt(arcPub as PublicClient, hash, 'releaseReservation')
      await removeOtcReservation(reservationId)
      results.push({
        spoke: 'arc',
        fillId: reservationId,
        action: 'released',
        detail: 'kv reservation expired',
        txHash: hash,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/done/i.test(msg)) {
        await removeOtcReservation(reservationId)
        continue
      }
      results.push({
        spoke: 'arc',
        fillId: reservationId,
        action: 'error',
        detail: `kv reservation sweep: ${msg.slice(0, 160)}`,
      })
    }
  }
}

/** Re-exported for the API route's env-sanity checks. */
export const OTC_KEEPER_ARC_CHAIN_ID = ARC_CHAIN_ID
