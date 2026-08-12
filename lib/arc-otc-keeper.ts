/**
 * Arc OTC desk keeper — settles Instant OTC fills (Base/ARB/ETH → Arc), on a schedule (see
 * app/api/arc/keeper/otc/route.ts + vercel.json cron).
 *
 * Ported from Robinpad's `lib/bridge/robin-otc-keeper-core.ts` (2026-08-12) — ArcFun's OTC panel
 * (app/otc) shares the exact same on-chain contracts as Robinpad (same liquidity escrow, same
 * Base/ARB payment escrows — see lib/bridge/robin-otc.ts's OTC_DEFAULTS), so this is a second,
 * independent keeper against the SAME contracts, not a separate desk. Found live 2026-08-12:
 * Robinpad's own keeper cron (runs every minute) had been 500ing on every tick for 25+ minutes
 * straight after working fine right before that — a buyer's fill sat stuck `pending` the whole
 * time with nothing settling it. Running ArcFun's own copy means a single keeper going down
 * doesn't leave every fill (from either frontend) stuck until someone notices.
 *
 * Flow per fill (v4 payment contract = reserve + lock):
 *   1. lock() on the payment escrow (blocks self-refund) BEFORE touching Arc
 *   2. deliver(..., reservationId) on the Arc liquidity contract
 *   3. settle() on the payment escrow
 *
 * If deliver() fails, re-check Arc `delivered[fillId]` before ever calling unlock() — never
 * unlock a fill Arc already paid out (that would reopen the double-spend/refund race the
 * lock-before-deliver ordering exists to close). Per-fill try/catch so one bad fill can't abort
 * the whole spoke, and per-spoke try/catch so one broken payment chain can't abort the others.
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

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

export type OtcKeeperTickResult = {
  spoke: string
  fillId: string
  action: 'skip' | 'locked' | 'delivered' | 'settled' | 'error'
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
] as const

const fillCreatedEvent = parseAbiItem(
  'event FillCreated(bytes32 indexed fillId, address indexed buyer, bytes32 indexed offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, uint256 sellerProceeds, uint256 serviceFee, bytes32 reservationId)',
)

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
  const lookback = opts?.lookbackBlocks ?? 8_000n
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

  // Reuse ArcFun's own hardened Arc RPC client (multi-endpoint fallback with correct 5xx/infra
  // error classification — see lib/contracts-arc.ts) instead of building a fresh one inline.
  const arcPub = arcPublicClient()
  const arcWallet = arcServerWalletClient(key)
  const liquidity = ROBIN_OTC_LIQUIDITY

  const results: OtcKeeperTickResult[] = []

  for (const spoke of spokes) {
    try {
      const pub = createPublicClient({ chain: spoke.chain, transport: http(spoke.rpc) }) as PublicClient
      const wallet = createWalletClient({
        account,
        chain: spoke.chain,
        transport: http(spoke.rpc),
      }) as WalletClient

      const latest = await pub.getBlockNumber()
      const from = latest > lookback ? latest - lookback : 0n
      const logs = await pub.getLogs({
        address: spoke.payment,
        event: fillCreatedEvent,
        fromBlock: from,
        toBlock: latest,
      })

      for (const log of logs) {
        const fillId = log.args.fillId as Hex
        if (!fillId) continue

        // Isolate each fill so one failure cannot abort the spoke.
        try {
          const fill = await pub.readContract({
            address: spoke.payment,
            abi: paymentAbi,
            functionName: 'fills',
            args: [fillId],
          })
          const status = Number(fill[9])
          if (status === FILL_STATUS.Settled || status === FILL_STATUS.Refunded) {
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
          const reservationId = fill[10] as Hex
          if (!reservationId || reservationId.toLowerCase() === ZERO_BYTES32) {
            results.push({
              spoke: spoke.id,
              fillId,
              action: 'error',
              detail: 'fill missing reservationId (old payment contract?)',
            })
            continue
          }

          // 1) lock BEFORE Arc — closes refund-after-deliver race
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
              await pub.waitForTransactionReceipt({ hash: lockHash })
              results.push({ spoke: spoke.id, fillId, action: 'locked', txHash: lockHash })
            }
          }

          // 2) Arc deliver (if not already)
          let already = await arcPub.readContract({
            address: liquidity,
            abi: liquidityAbi,
            functionName: 'delivered',
            args: [fillId],
          })

          if (!already) {
            if (dryRun) {
              results.push({
                spoke: spoke.id,
                fillId,
                action: 'delivered',
                detail: `dry-run deliver amount=${destAmount} reserve=${reservationId.slice(0, 10)}…`,
              })
              continue
            }
            try {
              const hash = await arcWallet.writeContract({
                account,
                chain: arcWallet.chain,
                address: liquidity,
                abi: liquidityAbi,
                functionName: 'deliver',
                args: [offerId, fillId, destAmount, destRecipient, sellerPayment, premiumBps, reservationId],
                gas: 300_000n,
              })
              await arcPub.waitForTransactionReceipt({ hash })
              results.push({ spoke: spoke.id, fillId, action: 'delivered', txHash: hash })
              already = true
            } catch (deliverErr) {
              const deliverMsg = deliverErr instanceof Error ? deliverErr.message : String(deliverErr)

              // Safe unlock: only if Arc did NOT pay (re-read delivered).
              let arcPaid = false
              try {
                arcPaid = await arcPub.readContract({
                  address: liquidity,
                  abi: liquidityAbi,
                  functionName: 'delivered',
                  args: [fillId],
                })
              } catch {
                /* treat as unknown — do not unlock */
              }

              if (arcPaid) {
                results.push({
                  spoke: spoke.id,
                  fillId,
                  action: 'error',
                  detail: `deliver reported error but Arc delivered=true — NOT unlocking (retry settle): ${deliverMsg}`,
                })
                // fall through to settle attempt
              } else {
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
                  await pub.waitForTransactionReceipt({ hash: unlockHash })
                  results.push({
                    spoke: spoke.id,
                    fillId,
                    action: 'error',
                    detail: `deliver failed, unlocked for refund: ${deliverMsg}`,
                  })
                } catch (unlockErr) {
                  const unlockMsg = unlockErr instanceof Error ? unlockErr.message : String(unlockErr)
                  results.push({
                    spoke: spoke.id,
                    fillId,
                    action: 'error',
                    detail: `deliver failed AND unlock failed — stuck Locked, needs owner.unlock(): ${deliverMsg} / ${unlockMsg}`,
                  })
                }
                continue
              }
            }
          }

          if (dryRun) {
            results.push({ spoke: spoke.id, fillId, action: 'settled', detail: 'dry-run settle' })
            continue
          }

          // 3) settle payment
          const sh = await wallet.writeContract({
            account,
            chain: spoke.chain,
            address: spoke.payment,
            abi: paymentAbi,
            functionName: 'settle',
            args: [fillId],
            gas: 200_000n,
          })
          await pub.waitForTransactionReceipt({ hash: sh })
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

  return {
    ok: true,
    keeper: account.address,
    liquidity,
    spokes: spokes.map((s) => s.id),
    results,
  }
}

/** Re-exported for the API route's env-sanity checks. */
export const OTC_KEEPER_ARC_CHAIN_ID = ARC_CHAIN_ID
