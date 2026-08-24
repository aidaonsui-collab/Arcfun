/**
 * x402 (HTTP 402 Payment Required) — "exact" scheme, EVM, self-facilitated on Arc.
 *
 * Why self-facilitated: the x402 reference implementation and every public facilitator
 * (x402.org, Coinbase, AWS AgentCore) are Base/Base-Sepolia only — Arc's chain id 5042 appears
 * nowhere in coinbase/x402. But "facilitator" is a role, not a vendor: verify an EIP-712
 * signature, then broadcast it. Arc USDC is FiatTokenV2 and supports EIP-3009
 * `transferWithAuthorization`, which is exactly what the exact scheme settles with — verified
 * live: calling it with a junk signature reverts "FiatTokenV2: invalid signature" (a contract
 * without the function reverts with no reason at all).
 *
 * Replay protection is the TOKEN's, not ours. EIP-3009 marks (authorizer, nonce) consumed
 * on-chain when the transfer lands, so a replayed payload simply reverts. We deliberately do
 * NOT gate this on KV: the indexer's KV is over its free-tier quota and failing reads
 * intermittently, and a payment path must not inherit that failure mode. We still *read*
 * authorizationState() as a pre-flight so a doomed payload fails fast and free.
 *
 * Spec: https://github.com/coinbase/x402 specs/x402-specification-v1.md
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem'
import { ARC, ARC_CHAIN_ID, arcChain, arcServerRpcUrls, arcServerWalletClient } from '@/lib/contracts-arc'

export const X402_VERSION = 1
/** Non-standard network id: no registered x402 name exists for Arc. Clients must match it verbatim. */
export const X402_NETWORK = 'arc'
export const USDC_DECIMALS = 6

/**
 * EIP-712 domain for Arc USDC. VERIFIED against the live contract 2026-08-23: keccak of
 * (EIP712Domain typehash, keccak"USDC", keccak"2", 5042, 0x36..00) reproduces the on-chain
 * DOMAIN_SEPARATOR() 0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84 exactly.
 * A wrong domain silently invalidates every signature, so do not edit without re-checking that.
 */
export function usdcDomain() {
  return {
    name: 'USDC',
    version: '2',
    chainId: ARC_CHAIN_ID,
    verifyingContract: ARC.USDC as Address,
  } as const
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const EIP3009_ABI = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

export type PaymentRequirements = {
  scheme: 'exact'
  network: string
  maxAmountRequired: string
  asset: Address
  payTo: Address
  resource: string
  description: string
  mimeType?: string
  outputSchema?: unknown
  maxTimeoutSeconds: number
  /** Scheme-specific: the token's EIP-712 name/version, so the client can build the domain. */
  extra: { name: string; version: string; decimals: number; chainId: number }
}

export type PaymentPayload = {
  x402Version: number
  scheme: string
  network: string
  payload: {
    signature: Hex
    authorization: {
      from: Address
      to: Address
      value: string
      validAfter: string
      validBefore: string
      nonce: Hex
    }
  }
}

// ── config ──────────────────────────────────────────────────────────────────

/** OFF unless explicitly enabled — the MCP venue must keep working untouched by default. */
export function x402Enabled(): boolean {
  return (process.env.X402_ENABLED || '').trim() === '1' && x402PayTo() !== null && x402KeeperKey() !== null
}

export function x402PayTo(): Address | null {
  const v = (process.env.X402_PAY_TO || '').trim()
  return isAddress(v) ? (v as Address) : null
}

/** Price per paid call in atomic USDC (6dp). Default 1000 = $0.001. */
export function x402PriceAtomic(): bigint {
  const raw = (process.env.X402_PRICE_ATOMIC || '').trim()
  if (!raw) return 1000n
  try {
    const n = BigInt(raw)
    return n > 0n ? n : 1000n
  } catch {
    return 1000n
  }
}

function x402KeeperKey(): Hex | null {
  const k = (process.env.ARC_OTC_KEEPER_KEY || process.env.ROBIN_OTC_KEEPER_KEY || '').trim()
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null
}

function readClient() {
  return createPublicClient({
    chain: arcChain,
    transport: http(arcServerRpcUrls()[0] || undefined, { retryCount: 1, timeout: 8_000 }),
  })
}

export function buildRequirements(resource: string, description: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    maxAmountRequired: x402PriceAtomic().toString(),
    asset: ARC.USDC as Address,
    payTo: x402PayTo() as Address,
    resource,
    description,
    mimeType: 'application/json',
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', decimals: USDC_DECIMALS, chainId: ARC_CHAIN_ID },
  }
}

// ── verify ──────────────────────────────────────────────────────────────────

export type VerifyResult = { ok: true; payload: PaymentPayload } | { ok: false; error: string }

export function decodePaymentHeader(header: string | null): VerifyResult {
  if (!header) return { ok: false, error: 'X-PAYMENT header is required' }
  try {
    const json = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload
    if (json?.scheme !== 'exact') return { ok: false, error: 'unsupported scheme (expected "exact")' }
    if (json?.network !== X402_NETWORK) return { ok: false, error: `unsupported network (expected "${X402_NETWORK}")` }
    const a = json?.payload?.authorization
    if (!a || !isAddress(a.from) || !isAddress(a.to)) return { ok: false, error: 'malformed authorization' }
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, error: 'malformed nonce' }
    if (!/^0x[0-9a-fA-F]{130}$/.test(json.payload.signature)) return { ok: false, error: 'malformed signature' }
    return { ok: true, payload: json }
  } catch {
    return { ok: false, error: 'X-PAYMENT must be base64-encoded JSON' }
  }
}

/**
 * Full pre-settlement verification, in the order the spec lists (§6.1.2). Every check runs
 * BEFORE any gas is spent, so a bad payload costs the keeper nothing.
 */
export async function verifyPayment(
  payload: PaymentPayload,
  req: PaymentRequirements,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const a = payload.payload.authorization
  let value: bigint
  let validAfter: bigint
  let validBefore: bigint
  try {
    value = BigInt(a.value)
    validAfter = BigInt(a.validAfter)
    validBefore = BigInt(a.validBefore)
  } catch {
    return { ok: false, error: 'authorization amounts must be integer strings' }
  }

  // 5. parameter matching — do this first, it's free and catches misdirected payments.
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) {
    return { ok: false, error: 'authorization.to does not match payTo' }
  }
  // 3. amount
  if (value < BigInt(req.maxAmountRequired)) {
    return { ok: false, error: `insufficient amount: need ${req.maxAmountRequired}, got ${a.value}` }
  }
  // 4. time window
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (validAfter > now) return { ok: false, error: 'authorization not yet valid' }
  if (validBefore <= now) return { ok: false, error: 'authorization expired' }

  // 1. signature
  let sigOk = false
  try {
    sigOk = await verifyTypedData({
      address: a.from,
      domain: usdcDomain(),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce },
      signature: payload.payload.signature,
    })
  } catch {
    sigOk = false
  }
  if (!sigOk) return { ok: false, error: 'invalid EIP-712 signature' }

  const client = readClient()

  // Replay: the token is the authority, but check first so a replay fails free instead of
  // burning keeper gas on a guaranteed revert.
  try {
    const used = (await client.readContract({
      address: ARC.USDC as Address,
      abi: EIP3009_ABI,
      functionName: 'authorizationState',
      args: [a.from, a.nonce],
    })) as boolean
    if (used) return { ok: false, error: 'authorization already used' }
  } catch {
    /* read failed — settlement still reverts safely on a real replay */
  }

  // 2. balance
  try {
    const bal = (await client.readContract({
      address: ARC.USDC as Address,
      abi: EIP3009_ABI,
      functionName: 'balanceOf',
      args: [a.from],
    })) as bigint
    if (bal < value) return { ok: false, error: 'payer has insufficient USDC balance' }
  } catch {
    /* read failed — let settlement decide */
  }

  return { ok: true }
}

// ── settle ──────────────────────────────────────────────────────────────────

export type SettleResult =
  | { ok: true; txHash: Hex; payer: Address; amount: string }
  | { ok: false; error: string }

/** Broadcast the authorization. Keeper pays gas; the payer signed but spends no gas. */
export async function settlePayment(payload: PaymentPayload): Promise<SettleResult> {
  const key = x402KeeperKey()
  if (!key) return { ok: false, error: 'facilitator keeper not configured' }
  const a = payload.payload.authorization
  const sig = payload.payload.signature
  const r = `0x${sig.slice(2, 66)}` as Hex
  const s = `0x${sig.slice(66, 130)}` as Hex
  let v = parseInt(sig.slice(130, 132), 16)
  if (v < 27) v += 27 // some signers emit 0/1

  try {
    const wallet = arcServerWalletClient(key)
    const data = encodeFunctionData({
      abi: EIP3009_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        a.from,
        a.to,
        BigInt(a.value),
        BigInt(a.validAfter),
        BigInt(a.validBefore),
        a.nonce,
        v,
        r,
        s,
      ],
    })
    const txHash = await wallet.sendTransaction({ to: ARC.USDC as Address, data })
    return { ok: true, txHash, payer: a.from, amount: a.value }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'settlement failed' }
  }
}

/** Value for the X-PAYMENT-RESPONSE header (base64 JSON), per the spec. */
export function encodePaymentResponse(r: SettleResult): string {
  const body = r.ok
    ? { success: true, transaction: r.txHash, network: X402_NETWORK, payer: r.payer, amount: r.amount }
    : { success: false, error: r.error, network: X402_NETWORK }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}
