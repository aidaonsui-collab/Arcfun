/**
 * Eve Vault backend — platform-treasury model, decided explicitly in session: no public
 * deposits, no redeemable shares, no third-party money pooled. This tracks ArcFun's own accrued
 * platform-fee USDC and (once an approved RWA market exists on Arc) will systematically invest
 * it. Contrast with lib/arc-eve-holder-rewards.ts, which redistributes collected fees to
 * third-party EVE holders — this module never sends anything to anyone outside the platform's
 * own treasury.
 *
 * Fee routing itself — pointing CrucibleLock's `platformWallet` at VAULT_TREASURY so Instant
 * platform fees actually start flowing here — is a separate, explicit, platform-wide decision
 * that hasn't been made yet (it repoints revenue for every current and future CrucibleLock
 * launch, not just one token). Nothing in this file does that. Until it happens, VAULT_TREASURY
 * is unconfigured and this honestly reports an empty treasury rather than fabricating numbers —
 * see lib/vault-data.ts's existing "This board is ready. The money is not." copy, which this
 * backend is built to match, not contradict.
 */
import { kv } from '@vercel/kv'
import { erc20Abi, isAddress, type Address } from 'viem'
import { ARC, arcPublicClient } from './contracts-arc'

function optionalEnvAddr(raw: string | undefined): Address | null {
  const v = (raw ?? '').trim()
  return v && isAddress(v) ? (v as Address) : null
}

/** Unset until the platform owner actually stands up a treasury address (a Safe/multisig is
 *  strongly preferred over a plain EOA for something meant to eventually hold real RWA
 *  positions) and the fee-routing step is separately approved. */
export const VAULT_TREASURY: Address | null = optionalEnvAddr(process.env.NEXT_PUBLIC_ARC_VAULT_TREASURY)

export interface ApprovedRwa {
  symbol: string
  address: Address
  /** Which DEX pool / route the keeper should buy through, once this is populated for real. */
  note?: string
}

/** Empty until an actual Arc RWA market + oracle exists to buy from — see lib/vault-data.ts's
 *  VAULT_RWAS for the curator candidate list this will eventually be populated from. Keeping
 *  this as a plain in-code list (not KV) for now: approving an RWA for real purchase is a
 *  deliberate, reviewed decision, not something any process should be able to toggle silently. */
export const VAULT_APPROVED_RWAS: ApprovedRwa[] = []

const STATE_KEY = 'arcfun:vault:state'

export interface VaultTreasuryState {
  lastSeenUsdcBalance: string
  /** Cumulative positive balance deltas observed over time — i.e. lifetime USDC that has ever
   *  flowed into the treasury, resilient to the balance later dropping when RWA purchases start
   *  spending it (a plain balanceOf() read alone couldn't tell "lifetime routed" from "currently
   *  held" once that happens). */
  totalRoutedUsdc: string
  lastCheckedAt: number
}

async function loadVaultState(): Promise<VaultTreasuryState> {
  const existing = await kv.get<VaultTreasuryState>(STATE_KEY)
  if (existing) return existing
  return { lastSeenUsdcBalance: '0', totalRoutedUsdc: '0', lastCheckedAt: 0 }
}

async function saveVaultState(state: VaultTreasuryState): Promise<void> {
  await kv.set(STATE_KEY, state)
}

export interface VaultSnapshot {
  configured: boolean
  treasuryAddress: Address | null
  usdcBalance: string
  totalRoutedUsdc: string
  approvedRwaCount: number
  rwaHoldings: []
  status: 'unconfigured' | 'escrowing' | 'awaiting_rwa_market'
  at: number
}

/**
 * Read-only snapshot for the dashboard — never mutates state (that's runVaultKeeperCycle's job).
 * Safe to call on every page load: one balanceOf() call when configured, otherwise instant.
 */
export async function getVaultSnapshot(): Promise<VaultSnapshot> {
  if (!VAULT_TREASURY) {
    return {
      configured: false,
      treasuryAddress: null,
      usdcBalance: '0',
      totalRoutedUsdc: '0',
      approvedRwaCount: VAULT_APPROVED_RWAS.length,
      rwaHoldings: [],
      status: 'unconfigured',
      at: Date.now(),
    }
  }

  const [balance, state] = await Promise.all([
    arcPublicClient()
      .readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [VAULT_TREASURY],
      })
      .catch(() => 0n) as Promise<bigint>,
    loadVaultState(),
  ])

  return {
    configured: true,
    treasuryAddress: VAULT_TREASURY,
    usdcBalance: balance.toString(),
    totalRoutedUsdc: state.totalRoutedUsdc,
    approvedRwaCount: VAULT_APPROVED_RWAS.length,
    rwaHoldings: [],
    status: VAULT_APPROVED_RWAS.length > 0 ? 'escrowing' : 'awaiting_rwa_market',
    at: Date.now(),
  }
}

export interface VaultKeeperResult {
  ok: boolean
  configured: boolean
  skipped?: string
  balance?: string
  routedDelta?: string
  totalRoutedUsdc?: string
}

/**
 * The "idle RWA-buy step." Runs on a cron. Does two things every tick:
 *   1. Bookkeeping — compares the treasury's current USDC balance to what was last seen and
 *      folds any increase into the lifetime totalRoutedUsdc counter. This is the only real work
 *      possible today, since nothing routes fees here yet (VAULT_TREASURY is unconfigured).
 *   2. Checks VAULT_APPROVED_RWAS. Empty today, so this always no-ops past bookkeeping with a
 *      clear "no approved RWA market yet" status — never a silent do-nothing that looks the same
 *      as a real failure. This is the seam where the actual buy-an-RWA logic plugs in later, once
 *      there's a real Arc RWA market + oracle to quote against and an approved list to buy from.
 */
export async function runVaultKeeperCycle(): Promise<VaultKeeperResult> {
  if (!VAULT_TREASURY) {
    return { ok: true, configured: false, skipped: 'VAULT_TREASURY not configured — no fee routing set up yet' }
  }

  const [balance, state] = await Promise.all([
    arcPublicClient()
      .readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [VAULT_TREASURY],
      })
      .catch(() => null) as Promise<bigint | null>,
    loadVaultState(),
  ])

  if (balance == null) {
    return { ok: false, configured: true, skipped: 'balanceOf read failed' }
  }

  const lastSeen = BigInt(state.lastSeenUsdcBalance)
  const delta = balance > lastSeen ? balance - lastSeen : 0n
  const nextState: VaultTreasuryState = {
    lastSeenUsdcBalance: balance.toString(),
    totalRoutedUsdc: (BigInt(state.totalRoutedUsdc) + delta).toString(),
    lastCheckedAt: Date.now(),
  }
  await saveVaultState(nextState)

  if (VAULT_APPROVED_RWAS.length === 0) {
    return {
      ok: true,
      configured: true,
      skipped: 'no approved RWA market yet — see VAULT_APPROVED_RWAS',
      balance: balance.toString(),
      routedDelta: delta.toString(),
      totalRoutedUsdc: nextState.totalRoutedUsdc,
    }
  }

  // TODO once VAULT_APPROVED_RWAS is populated: quote + buy the approved RWA(s) with the
  // available balance, respecting each entry's cap. Not implemented — there is nothing to buy
  // from yet (see lib/vault-data.ts's VAULT_RWAS candidate list and the "Circle mainnet window"
  // this whole feature is gated on).
  return {
    ok: true,
    configured: true,
    skipped: 'RWA buy logic not implemented yet',
    balance: balance.toString(),
    routedDelta: delta.toString(),
    totalRoutedUsdc: nextState.totalRoutedUsdc,
  }
}
