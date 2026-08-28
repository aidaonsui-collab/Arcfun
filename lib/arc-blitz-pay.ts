/**
 * Blitz nanogas: x402 exact-scheme USDC on Arc.
 * Pay-to = X402_PAY_TO, else EveBurn (USDC later cooks to $EVE → dead).
 */
import { isAddress, type Address } from 'viem'
import { ARC, ARC_CHAIN_ID } from './contracts-arc'
import {
  USDC_DECIMALS,
  X402_NETWORK,
  x402FacilitatorKey,
  x402PayTo,
  type PaymentRequirements,
} from './x402'
import { eveBurnAddress } from './eve'

export function blitzPayTo(): Address | null {
  return x402PayTo() ?? eveBurnAddress()
}

export function blitzPayEnabled(): boolean {
  return blitzPayTo() !== null && x402FacilitatorKey() !== null
}

/** Atomic USDC (6dp). Default 10000 = $0.01 nanogas. */
export function blitzLaunchPriceAtomic(): bigint {
  const raw = (process.env.BLITZ_X402_PRICE_ATOMIC || '').trim()
  if (raw) {
    try {
      const n = BigInt(raw)
      if (n > 0n) return n
    } catch {
      /* fall through */
    }
  }
  return 10_000n
}

export function blitzLaunchUsdLabel(): string {
  const n = Number(blitzLaunchPriceAtomic()) / 1e6
  if (!Number.isFinite(n)) return '$0.01'
  if (n >= 0.01) return `$${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

export function blitzLaunchRequirements(resource: string): PaymentRequirements {
  const payTo = blitzPayTo()
  if (!payTo || !isAddress(payTo)) {
    throw new Error('blitz payTo not configured')
  }
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    maxAmountRequired: blitzLaunchPriceAtomic().toString(),
    asset: ARC.USDC as Address,
    payTo,
    resource,
    description: 'Arcfun Blitz Instant launch (nanogas)',
    mimeType: 'application/json',
    maxTimeoutSeconds: 600,
    extra: { name: 'USDC', version: '2', decimals: USDC_DECIMALS, chainId: ARC_CHAIN_ID },
  }
}
