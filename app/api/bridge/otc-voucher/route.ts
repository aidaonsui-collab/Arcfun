/**
 * GET /api/bridge/otc-voucher?address=0x…&chainId=8453|42161
 *
 * Two independent exceptions to the standard Arc OTC platform fee, both via the same
 * oracle-signed voucher mechanism (RobinOtcPayment.fillOfferRobin) — the payment contract just
 * verifies (holder, feeBps, deadline) was signed by its feeOracle() address; it has no idea, or
 * need to know, why. Checked in order, first match wins (EVE's is strictly better so there's no
 * need to compare, only to short-circuit):
 *
 *   1. EVE balance ≥0.1% of supply on Arc → feeBps=0 (full waiver)
 *   2. ROBIN balance ≥0.01% of supply on rh4663 → feeBps=100 (1%, half the 2% default)
 *
 * Default fee is 2%.
 */
import { NextResponse } from 'next/server'
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ROBIN_TOKEN,
  ROBIN_DECIMALS,
  ROBIN_WAIVER_SUPPLY_BPS,
  ROBIN_WAIVER_HINT,
  EVE_TOKEN,
  EVE_DECIMALS,
  EVE_WAIVER_SUPPLY_BPS,
  EVE_WAIVER_HINT,
} from '@/lib/bridge/constants'
import {
  OTC_DEFAULTS,
  OTC_DEFAULT_FEE_BPS,
  OTC_ROBIN_FEE_BPS,
  OTC_EVE_FEE_BPS,
  robinOtcEnabled,
} from '@/lib/bridge/robin-otc'
import { arcPublicClient } from '@/lib/contracts-arc'

export const dynamic = 'force-dynamic'

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

const VOUCHER_TTL_SEC = 15 * 60

function rhRpc(): string {
  return (
    process.env.RH4663_RPC ||
    process.env.RH4663_PAID_RPC ||
    process.env.NEXT_PUBLIC_RH4663_RPC ||
    process.env.NEXT_PUBLIC_RH4663_RPC_URL ||
    ''
  )
}

function oracleKey(): Hex | null {
  for (const name of ['ROBIN_OTC_FEE_ORACLE_KEY', 'BRIDGE_FEE_ORACLE_KEY', 'PRIVATE_KEY']) {
    const k = (process.env[name] || '').trim()
    if (/^0x[a-fA-F0-9]{64}$/.test(k)) return k as Hex
    if (/^[a-fA-F0-9]{64}$/.test(k)) return `0x${k}` as Hex
  }
  return null
}

function paymentForChain(chainId: number): Address {
  if (chainId === 8453) return OTC_DEFAULTS.paymentBase
  if (chainId === 42161) return OTC_DEFAULTS.paymentArb
  return OTC_DEFAULTS.paymentBase
}

/** Same EIP-712 domain/type the deployed RobinOtcPayment contracts already verify on-chain for
 *  fillOfferRobin — feeBps is whatever the caller passes, the contract has no per-reason logic. */
async function signFeeVoucher(
  key: Hex,
  chainId: number,
  verifyingContract: Address,
  holder: Address,
  feeBps: number,
  deadline: number,
): Promise<{ signature: Hex; signer: Address }> {
  const account = privateKeyToAccount(key)
  const signature = await account.signTypedData({
    domain: {
      name: 'RobinOtcPayment',
      version: '1',
      chainId,
      verifyingContract,
    },
    types: {
      RobinOtcFee: [
        { name: 'holder', type: 'address' },
        { name: 'feeBps', type: 'uint16' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'RobinOtcFee',
    message: { holder, feeBps, deadline: BigInt(deadline) },
  })
  return { signature, signer: account.address }
}

export async function GET(req: Request) {
  if (!robinOtcEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const url = new URL(req.url)
  const address = (url.searchParams.get('address') || '').trim()
  const chainId = Number(url.searchParams.get('chainId') || '8453')
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }
  if (chainId !== 8453 && chainId !== 42161) {
    return NextResponse.json({ error: 'unsupported chainId' }, { status: 400 })
  }

  const verifyingContract = paymentForChain(chainId)
  const holder = address as Address

  // 1. EVE waiver — checked against Arc directly, independent of which payment chain the buyer
  //    picked. Best-effort: a read failure here just falls through to the ROBIN check below
  //    rather than failing the whole voucher request.
  let eveEligible = false
  let eveBalance = 0
  let eveThreshold = EVE_WAIVER_HINT
  try {
    const arc = arcPublicClient()
    const [bal, supply] = await Promise.all([
      arc.readContract({ address: EVE_TOKEN, abi: ERC20, functionName: 'balanceOf', args: [holder] }),
      arc.readContract({ address: EVE_TOKEN, abi: ERC20, functionName: 'totalSupply' }),
    ])
    const thresholdRaw = (supply * BigInt(EVE_WAIVER_SUPPLY_BPS)) / 10_000n
    eveEligible = thresholdRaw > 0n && bal >= thresholdRaw
    const scale = 10 ** EVE_DECIMALS
    eveBalance = Number(bal) / scale
    eveThreshold = Number(thresholdRaw) / scale
  } catch {
    /* fall through */
  }

  if (eveEligible) {
    const key = oracleKey()
    if (!key) {
      return NextResponse.json({
        eligible: true,
        feeBps: OTC_EVE_FEE_BPS,
        robinFeeBps: OTC_EVE_FEE_BPS,
        eveBalance,
        eveThreshold,
        reason: 'Fee oracle signing is not configured on this deployment',
      })
    }
    const deadline = Math.floor(Date.now() / 1000) + VOUCHER_TTL_SEC
    const { signature, signer } = await signFeeVoucher(key, chainId, verifyingContract, holder, OTC_EVE_FEE_BPS, deadline)
    return NextResponse.json({
      eligible: true,
      feeBps: OTC_EVE_FEE_BPS,
      robinFeeBps: OTC_EVE_FEE_BPS,
      eveBalance,
      eveThreshold,
      deadline,
      signature,
      chainId,
      payment: verifyingContract,
      signer,
      reason: 'EVE holder platform fee waiver (≥0.1% supply) — fee waived',
    })
  }

  // 2. ROBIN discount (unchanged) — only reached when the EVE waiver above didn't apply.
  const rpc = rhRpc()
  if (!rpc) {
    return NextResponse.json({
      eligible: false,
      feeBps: OTC_DEFAULT_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance: 0,
      robinThreshold: ROBIN_WAIVER_HINT,
      eveBalance,
      eveThreshold,
      reason: 'rh4663 RPC not configured',
    })
  }

  try {
    const client = createPublicClient({ transport: http(rpc) })
    const [bal, supply] = await Promise.all([
      client.readContract({ address: ROBIN_TOKEN, abi: ERC20, functionName: 'balanceOf', args: [holder] }),
      client.readContract({ address: ROBIN_TOKEN, abi: ERC20, functionName: 'totalSupply' }),
    ])
    const thresholdRaw = (supply * BigInt(ROBIN_WAIVER_SUPPLY_BPS)) / 10_000n
    const eligible = bal >= thresholdRaw && thresholdRaw > 0n
    const scale = 10 ** ROBIN_DECIMALS
    const robinBalance = Number(bal) / scale
    const robinThreshold = Number(thresholdRaw) / scale

    if (!eligible) {
      return NextResponse.json({
        eligible: false,
        feeBps: OTC_DEFAULT_FEE_BPS,
        robinFeeBps: OTC_ROBIN_FEE_BPS,
        robinBalance,
        robinThreshold,
        eveBalance,
        eveThreshold,
        reason: 'Standard Arc OTC platform fee applies',
      })
    }

    const key = oracleKey()
    if (!key) {
      return NextResponse.json({
        eligible: true,
        feeBps: OTC_ROBIN_FEE_BPS,
        robinFeeBps: OTC_ROBIN_FEE_BPS,
        robinBalance,
        robinThreshold,
        eveBalance,
        eveThreshold,
        reason: 'Fee oracle signing is not configured on this deployment',
      })
    }

    const deadline = Math.floor(Date.now() / 1000) + VOUCHER_TTL_SEC
    const { signature, signer } = await signFeeVoucher(key, chainId, verifyingContract, holder, OTC_ROBIN_FEE_BPS, deadline)

    return NextResponse.json({
      eligible: true,
      feeBps: OTC_ROBIN_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance,
      robinThreshold,
      eveBalance,
      eveThreshold,
      deadline,
      signature,
      chainId,
      payment: verifyingContract,
      signer,
      reason: 'Reduced Arc OTC platform fee voucher',
    })
  } catch (e) {
    return NextResponse.json({
      eligible: false,
      feeBps: OTC_DEFAULT_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance: 0,
      robinThreshold: ROBIN_WAIVER_HINT,
      eveBalance,
      eveThreshold,
      reason: (e as Error).message || 'balance read failed',
    })
  }
}
