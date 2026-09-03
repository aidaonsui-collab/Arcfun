/**
 * GET /api/bridge/otc-voucher?address=0x…&chainId=8453|42161
 *
 * ROBIN balance on rh4663 ≥ 0.01% supply → EIP-712 RobinOtcFee voucher
 * for fillOfferRobin (1% platform fee). Default fee is 3%.
 */
import { NextResponse } from 'next/server'
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ROBIN_TOKEN,
  ROBIN_DECIMALS,
  ROBIN_WAIVER_SUPPLY_BPS,
  ROBIN_WAIVER_HINT,
} from '@/lib/bridge/constants'
import {
  OTC_DEFAULTS,
  OTC_DEFAULT_FEE_BPS,
  OTC_ROBIN_FEE_BPS,
  robinOtcEnabled,
} from '@/lib/bridge/robin-otc'

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
  const rpc = rhRpc()
  if (!rpc) {
    return NextResponse.json({
      eligible: false,
      feeBps: OTC_DEFAULT_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance: 0,
      robinThreshold: ROBIN_WAIVER_HINT,
      reason: 'rh4663 RPC not configured',
    })
  }

  try {
    const client = createPublicClient({ transport: http(rpc) })
    const [bal, supply] = await Promise.all([
      client.readContract({
        address: ROBIN_TOKEN,
        abi: ERC20,
        functionName: 'balanceOf',
        args: [address as Address],
      }),
      client.readContract({
        address: ROBIN_TOKEN,
        abi: ERC20,
        functionName: 'totalSupply',
      }),
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
        reason: 'Fee oracle signing is not configured on this deployment',
      })
    }

    const deadline = Math.floor(Date.now() / 1000) + VOUCHER_TTL_SEC
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
      message: {
        holder: address as Address,
        feeBps: OTC_ROBIN_FEE_BPS,
        deadline: BigInt(deadline),
      },
    })

    return NextResponse.json({
      eligible: true,
      feeBps: OTC_ROBIN_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance,
      robinThreshold,
      deadline,
      signature,
      chainId,
      payment: verifyingContract,
      signer: account.address,
      reason: 'Reduced Arc OTC platform fee voucher',
    })
  } catch (e) {
    return NextResponse.json({
      eligible: false,
      feeBps: OTC_DEFAULT_FEE_BPS,
      robinFeeBps: OTC_ROBIN_FEE_BPS,
      robinBalance: 0,
      robinThreshold: ROBIN_WAIVER_HINT,
      reason: (e as Error).message || 'balance read failed',
    })
  }
}
