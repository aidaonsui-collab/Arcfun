/**
 * POST /api/handle-pay/voucher — claim authorization for a HandlePay vault.
 *
 * Caller presents a verifyToken from the X OAuth flow proving they control the
 * handle, bound to {handle, wallet}. We read the vault + current nonce on-chain
 * and sign Claim{recipient, nonce} in the vault's EIP-712 domain.
 *
 * Body: { verifyToken, handle, recipient }
 */
import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { privateKeyToAccount } from 'viem/accounts'
import { isAddress, type Address, type Hex } from 'viem'
import {
  HANDLE_PAY_FACTORY,
  HANDLE_PAY_FACTORY_ABI,
  HANDLE_PAY_ABI,
  handleHashFor,
  handlePayEnabled,
  handlePayClaimTypedData,
  handlePayGiftId,
  normaliseXHandle,
} from '@/lib/handle-pay'
import { ARC_CHAIN_ID, arcPublicClient } from '@/lib/contracts-arc'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

interface VerifyRecord {
  username: string
  giftId: string
  walletAddress: string
}

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'handle-pay-voucher', 8, 60, true)
  if (limited) return limited

  try {
    const raw = (process.env.HANDLE_PAY_SIGNER_KEY || '').trim()
    if (!raw) return NextResponse.json({ error: 'Voucher signer not configured' }, { status: 503 })
    if (!handlePayEnabled()) {
      return NextResponse.json({ error: 'HandlePay factory not configured' }, { status: 503 })
    }
    const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex

    const { verifyToken, handle: handleRaw, recipient } = await req.json()
    const handle = normaliseXHandle(String(handleRaw || ''))
    if (!verifyToken || !handle || !recipient) {
      return NextResponse.json({ error: 'verifyToken, handle and recipient are required' }, { status: 400 })
    }
    if (!isAddress(String(recipient))) {
      return NextResponse.json({ error: 'recipient must be a valid EVM address' }, { status: 400 })
    }

    const session = await kv.get<VerifyRecord>(`handlepay:verify:${verifyToken}`)
    if (!session) return NextResponse.json({ error: 'Invalid or expired verification token' }, { status: 401 })
    if (session.giftId !== handlePayGiftId(handle)) {
      return NextResponse.json({ error: 'Token not valid for this handle' }, { status: 403 })
    }
    if (session.walletAddress.toLowerCase() !== String(recipient).toLowerCase()) {
      return NextResponse.json({ error: 'Wallet mismatch — re-verify with this wallet connected' }, { status: 403 })
    }
    if (session.username !== handle) {
      return NextResponse.json({ error: `Verified as @${session.username}, not @${handle}` }, { status: 403 })
    }

    const client = arcPublicClient()
    const vault = (await client.readContract({
      address: HANDLE_PAY_FACTORY,
      abi: HANDLE_PAY_FACTORY_ABI,
      functionName: 'vaultOf',
      args: [handleHashFor(handle)],
    })) as Address
    if (/^0x0+$/i.test(vault)) {
      return NextResponse.json({ error: 'No rewards vault exists for this handle yet' }, { status: 404 })
    }
    const nonce = (await client.readContract({
      address: vault,
      abi: HANDLE_PAY_ABI,
      functionName: 'nonce',
    })) as bigint

    const account = privateKeyToAccount(key)
    const signature = await account.signTypedData(
      handlePayClaimTypedData(ARC_CHAIN_ID, vault, String(recipient) as Address, nonce),
    )
    return NextResponse.json({ signature, vault, nonce: nonce.toString(), signer: account.address })
  } catch (e) {
    console.error('[handle-pay/voucher]', e)
    return NextResponse.json({ error: (e as Error).message || 'Unknown error' }, { status: 500 })
  }
}
