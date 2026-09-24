/**
 * Gateway-agnostic conversation loop for the iMessage $EVE buy-bot: text in → reply out.
 * A Messages gateway (Phase 3) only has to call `handle(phoneKey(from), text)` and send the reply.
 * Quoting, balances and submission are injected so this file has no network or signing code.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { formatUnits, type Address, type Hex } from 'viem'
import { parseIntent } from './intent'
import { encodeKernelBatch, type Call } from './kernel'
import { capViolation, checkBuyCalls, usd, type BuyPolicy } from './policy'

export type BuyPlan = {
  usdcIn: bigint
  quotedOut: bigint
  minOut: bigint
  poolFee: number
  platformFeeBps: number
  slippageBps: number
  calls: Call[]
}

export type Submission = { quoteId: string; sender: Address | null; callData: Hex; calls: Call[] }

export type BotDeps = {
  policy: BuyPolicy
  quoteBuy: (usdcIn: bigint, account: Address | null) => Promise<BuyPlan>
  accountOf: (user: string) => Address | null
  balances?: (account: Address) => Promise<{ usdc: bigint; token: bigint }>
  submit: (s: Submission) => Promise<{ txHash?: Hex; dryRun?: boolean }>
  explorer?: string
  now?: () => number
  quoteTtlMs?: number
}

export type BotReply = { text: string; quoteId?: string; submission?: Submission; violations?: string[] }

type Pending = BuyPlan & { id: string; expiresAt: number }

export const HELP_TEXT = [
  'Text:',
  '• buy $5 of $eve — get a quote',
  '• YES — confirm it (quotes expire in 60s)',
  '• cancel — drop the quote',
  '• balance — your USDC and $EVE',
].join('\n')

/** Stable per-phone key. The salt must be secret: an unsalted phone hash is trivially reversible. */
export function phoneKey(phone: string, salt: string): string {
  if (!salt) throw new Error('phoneKey needs a secret salt')
  return createHmac('sha256', salt).update(phone.replace(/[^\d+]/g, '')).digest('hex')
}

const eve = (v: bigint) =>
  Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
const pct = (bps: number) => `${bps / 100}%`

export function createBuyBot(deps: BotDeps) {
  const now = deps.now ?? Date.now
  const ttl = deps.quoteTtlMs ?? 60_000
  const pending = new Map<string, Pending>()
  const spent = new Map<string, bigint>()
  const dayKey = (user: string) => `${user}:${new Date(now()).toISOString().slice(0, 10)}`
  const spentToday = (user: string) => spent.get(dayKey(user)) ?? 0n

  async function handle(user: string, text: string): Promise<BotReply> {
    const intent = parseIntent(text)
    switch (intent.kind) {
      case 'help':
        return { text: HELP_TEXT }
      case 'reject':
        return { text: intent.reason }
      case 'link':
        return { text: 'Wallet linking is not live yet.' }
      case 'cancel':
        return { text: pending.delete(user) ? 'Cancelled.' : 'Nothing to cancel.' }
      case 'balance': {
        const account = deps.accountOf(user)
        if (!account) return { text: 'No wallet linked to this number yet.' }
        if (!deps.balances) return { text: 'Balances are unavailable right now.' }
        const b = await deps.balances(account)
        return { text: `${usd(b.usdc)} USDC · ${eve(b.token)} $EVE\nWallet ${account}` }
      }
      case 'buy':
        return quote(user, intent.usdcIn)
      case 'yes':
        return confirm(user)
    }
  }

  async function quote(user: string, usdcIn: bigint): Promise<BotReply> {
    const cap = capViolation(usdcIn, deps.policy, spentToday(user))
    if (cap) return { text: cap }
    let plan: BuyPlan
    try {
      plan = await deps.quoteBuy(usdcIn, deps.accountOf(user))
    } catch {
      return { text: "Couldn't get a quote right now. Try again in a moment." }
    }
    const violations = checkBuyCalls(plan.calls, plan, deps.policy, spentToday(user))
    if (violations.length) {
      pending.delete(user)
      return { text: "Can't build this buy safely right now, so no quote was sent.", violations }
    }
    const id = randomUUID()
    pending.set(user, { ...plan, id, expiresAt: now() + ttl })
    return {
      quoteId: id,
      text: [
        `Buy ${usd(plan.usdcIn)} USDC → ~${eve(plan.quotedOut)} $EVE`,
        `Pool fee ${pct(plan.poolFee / 100)} · platform fee ${pct(plan.platformFeeBps)} · slippage ${pct(plan.slippageBps)}`,
        `Min out: ${eve(plan.minOut)} $EVE`,
        `Expires in ${Math.round(ttl / 1000)}s — reply YES to confirm`,
      ].join('\n'),
    }
  }

  async function confirm(user: string): Promise<BotReply> {
    const p = pending.get(user)
    pending.delete(user)
    if (!p) return { text: 'No pending quote. Text e.g. "buy $5 of $eve".' }
    if (now() > p.expiresAt) return { text: 'That quote expired. Text buy again for a fresh one.' }
    const violations = checkBuyCalls(p.calls, p, deps.policy, spentToday(user))
    if (violations.length) return { text: "Can't run this buy safely, so nothing was sent.", violations }

    const submission: Submission = {
      quoteId: p.id,
      sender: deps.accountOf(user),
      callData: encodeKernelBatch(p.calls),
      calls: p.calls,
    }
    let result: { txHash?: Hex; dryRun?: boolean }
    try {
      result = await deps.submit(submission)
    } catch (e) {
      return { text: `Buy didn't go through: ${(e as Error).message}`, submission }
    }
    spent.set(dayKey(user), spentToday(user) + p.usdcIn)
    const line = `~${eve(p.quotedOut)} $EVE for ${usd(p.usdcIn)} (min ${eve(p.minOut)})`
    if (result.dryRun) return { text: `Dry run — would buy ${line}. Nothing was sent.`, submission }
    const link = result.txHash && deps.explorer ? `\n${deps.explorer}/tx/${result.txHash}` : ''
    return { text: `Sent — buying ${line}.${link}`, submission }
  }

  return { handle }
}
