'use client'

/**
 * Holder rewards + referral — used on your creator profile (was /portfolio).
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { Check, Copy, Loader2 } from 'lucide-react'
import type { Address } from 'viem'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { REFLECTION_REWARD_ABI, type ReflectionRewardLine } from '@/lib/arc-reflection-rewards'
import { fmtUsd } from '@/lib/ui-format'
import { getOrCreateReferralCode, referralLink } from '@/lib/crucible'

type PortfolioPayload = {
  address: string
  usdcRewards: {
    claimable: number
    pending: number
    earned: number
    claimed: number
    otherClaimable: { symbol: string; amount: number }[]
  }
  reflectionLines: ReflectionRewardLine[]
  tokensChecked: number
  at: number
}

function fmtReward(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00'
  if (n >= 1000) return fmtUsd(n)
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(4)}`
  if (n > 0) return `$${n.toFixed(6)}`
  return '$0.00'
}

function ReferralRow({ wallet }: { wallet: string }) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setCode(getOrCreateReferralCode(wallet))
  }, [wallet])

  const link = code ? referralLink(code) : ''

  const copy = () => {
    if (!link) return
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <section className="border border-hair rounded-[24px] bg-s1 overflow-hidden mb-5">
      <div className="px-5 py-4 border-b border-hair2">
        <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Referrer</h2>
        <p className="m-0 mt-0.5 text-[13px] text-t3">
          Share this anytime after a launch. Buys through Arcfun with your code pay you 0.05% of
          the USDC in, instantly. Direct Uni swaps do not.
        </p>
      </div>
      <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-center">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">Your link</p>
          <p className="m-0 mt-1 text-sm font-semibold tabular-nums tracking-tightish truncate">
            {link || '…'}
          </p>
          <p className="m-0 mt-2 text-[13px] text-t3">
            Earned USDC{' '}
            <span className="text-white font-semibold tabular-nums">$0.00</span>
            <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide">preview</span>
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          disabled={!link}
          className="h-9 inline-flex items-center justify-center gap-1.5 px-3.5 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white disabled:opacity-40"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-lime-t" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </section>
  )
}

export function PortfolioDesk({ wallet }: { wallet: Address | string }) {
  const { chainId } = useAccount()
  const wrongChain = chainId != null && chainId !== ARC_CHAIN_ID
  const addr = wallet as Address

  const [portfolio, setPortfolio] = useState<PortfolioPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimingToken, setClaimingToken] = useState<Address | null>(null)

  const {
    writeContract,
    data: claimTx,
    isPending: claimPending,
    error: claimWriteErr,
    reset: resetClaim,
  } = useWriteContract()
  const { isLoading: claimConfirming, isSuccess: claimOk } = useWaitForTransactionReceipt({
    hash: claimTx,
  })

  const load = useCallback(async () => {
    if (!addr) {
      setPortfolio(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/arc/portfolio/${addr}`, { cache: 'no-store' })
      const data = (await res.json()) as {
        ok?: boolean
        portfolio?: PortfolioPayload
        error?: string
      }
      if (!res.ok || !data.ok || !data.portfolio) {
        setError(data.error || 'Failed to load rewards')
        setPortfolio(null)
        return
      }
      setPortfolio(data.portfolio)
    } catch (e) {
      setError((e as Error).message)
      setPortfolio(null)
    } finally {
      setLoading(false)
    }
  }, [addr])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (claimOk) {
      setClaimingToken(null)
      resetClaim()
      void load()
    }
  }, [claimOk, load, resetClaim])

  const claimOne = (token: Address) => {
    if (wrongChain) {
      alert('Switch to Arc mainnet first')
      return
    }
    setClaimingToken(token)
    writeContract({
      address: token,
      abi: REFLECTION_REWARD_ABI,
      functionName: 'claim',
      chainId: ARC_CHAIN_ID,
    })
  }

  const claimable = portfolio?.usdcRewards.claimable ?? 0
  const pending = portfolio?.usdcRewards.pending ?? 0
  const earned = portfolio?.usdcRewards.earned ?? 0
  const claimed = portfolio?.usdcRewards.claimed ?? 0
  const claimableLines =
    portfolio?.reflectionLines.filter((l) => l.claimableHuman > 0 && l.isUsdcReward) ?? []

  return (
    <div id="rewards" className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Holder rewards</h2>
          <p className="m-0 mt-0.5 text-[13px] text-t3">
            Instant Reflection USDC from tokens you hold. Claim is per token.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="h-9 px-3.5 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="mb-3 text-sm text-coral">{error}</p> : null}

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="border border-violet-400/35 rounded-[20px] bg-gradient-to-br from-violet-500/15 to-s1 px-5 py-4">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-violet-200/90">
            USDC rewards
          </p>
          <p className="m-0 mt-2 text-[28px] font-semibold tracking-tightish tabular-nums text-white">
            {loading && !portfolio
              ? '—'
              : claimable > 0
                ? fmtReward(claimable)
                : pending > 0
                  ? fmtReward(pending)
                  : fmtReward(0)}
          </p>
          <p className="m-0 mt-1 text-[13px] text-violet-100/70">
            {claimable > 0
              ? pending > 0
                ? `Claimable now · ${fmtReward(pending)} next sweep`
                : 'Claimable now · Instant Reflection'
              : pending > 0
                ? 'Next sweep · Instant Reflection'
                : 'No rewards yet'}
          </p>
        </div>
        <div className="border border-hair rounded-[20px] bg-s1 px-5 py-4">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">
            Lifetime earned
          </p>
          <p className="m-0 mt-2 text-[28px] font-semibold tracking-tightish tabular-nums">
            {loading && !portfolio ? '—' : fmtReward(earned)}
          </p>
          <p className="m-0 mt-1 text-[13px] text-t3">Accrued from reflections (incl. claimed)</p>
        </div>
        <div className="border border-hair rounded-[20px] bg-s1 px-5 py-4">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">
            Already claimed
          </p>
          <p className="m-0 mt-2 text-[28px] font-semibold tracking-tightish tabular-nums">
            {loading && !portfolio ? '—' : fmtReward(claimed)}
          </p>
          <p className="m-0 mt-1 text-[13px] text-t3">Pushed or manual claim()</p>
        </div>
      </section>

      <ReferralRow wallet={addr} />

      {portfolio?.usdcRewards.otherClaimable?.length ? (
        <p className="mb-4 text-sm text-t3">
          Also claimable (non-USDC):{' '}
          {portfolio.usdcRewards.otherClaimable
            .map((o) => `${o.amount.toFixed(4)} ${o.symbol}`)
            .join(' · ')}
        </p>
      ) : null}

      <section className="border border-hair rounded-[24px] bg-s1 overflow-hidden">
        <div className="px-5 py-4 border-b border-hair2">
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">
            Reflection rewards by token
          </h2>
          <p className="m-0 mt-0.5 text-[13px] text-t3">
            Checked {portfolio?.tokensChecked ?? 0} reflection launches
          </p>
        </div>

        {loading && !portfolio ? (
          <div className="flex justify-center py-14">
            <Loader2 className="w-7 h-7 animate-spin text-lime-t" />
          </div>
        ) : !portfolio?.reflectionLines.length ? (
          <div className="px-5 py-12 text-center text-sm text-t3">
            No reflection reward balance yet. Hold Instant Reflection tokens to earn USDC from
            trading fees.
            <div className="mt-4">
              <Link href="/create" className="text-lime-t font-semibold hover:text-white">
                Launch a reflection token →
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[12px] font-semibold text-t3 border-b border-hair2">
                  <th className="px-5 py-3 font-semibold">Token</th>
                  <th className="px-5 py-3 font-semibold text-right">Holding</th>
                  <th className="px-5 py-3 font-semibold text-right">Claimable</th>
                  <th className="px-5 py-3 font-semibold text-right hidden sm:table-cell">
                    Earned
                  </th>
                  <th className="px-5 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.reflectionLines.map((line) => {
                  const busy =
                    (claimPending || claimConfirming) && claimingToken === line.token
                  return (
                    <tr
                      key={line.token}
                      className="border-b border-hair2 last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/token/${line.token}`}
                          className="font-semibold tracking-tightish hover:text-lime-t"
                        >
                          {line.name}{' '}
                          <span className="text-t3 font-medium">${line.symbol}</span>
                        </Link>
                        <p className="m-0 mt-0.5 text-[11px] text-t3">
                          Reward: {line.rewardSymbol}
                          {line.isUsdcReward ? '' : ' (non-USDC)'}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-t2">
                        {line.holdingHuman > 0
                          ? line.holdingHuman.toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })
                          : '0'}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-semibold text-violet-200">
                        {line.isUsdcReward
                          ? fmtReward(line.claimableHuman)
                          : `${line.claimableHuman.toFixed(4)} ${line.rewardSymbol}`}
                        {line.pendingHuman > 0 && line.claimableHuman <= 0 ? (
                          <p className="m-0 mt-0.5 text-[11px] font-medium text-violet-100/60">
                            {fmtReward(line.pendingHuman)} next sweep
                          </p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-t2 hidden sm:table-cell">
                        {line.isUsdcReward
                          ? fmtReward(line.earnedHuman)
                          : `${line.earnedHuman.toFixed(4)} ${line.rewardSymbol}`}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          type="button"
                          disabled={busy || line.claimableHuman <= 0 || wrongChain}
                          onClick={() => claimOne(line.token as Address)}
                          className="inline-flex h-8 items-center px-3 rounded-lg bg-violet-500/90 text-white text-xs font-semibold hover:bg-violet-500 disabled:opacity-40"
                        >
                          {busy ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> …
                            </>
                          ) : (
                            'Claim'
                          )}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {claimWriteErr ? (
          <p className="px-5 py-3 text-[13px] text-coral border-t border-hair2">
            {claimWriteErr.message}
          </p>
        ) : null}

        {claimableLines.length > 1 ? (
          <p className="px-5 py-3 text-[12px] text-t3 border-t border-hair2">
            Claim is one transaction per token (token.claim()). Claimable total{' '}
            <span className="text-violet-200 font-semibold">{fmtReward(claimable)}</span>.
          </p>
        ) : null}
      </section>
    </div>
  )
}
