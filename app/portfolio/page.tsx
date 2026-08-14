'use client'

/**
 * Wallet portfolio — USDC reflection rewards tile + per-token breakdown / claim.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  useAccount,
  useConnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { Loader2 } from 'lucide-react'
import type { Address } from 'viem'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { REFLECTION_REWARD_ABI, type ReflectionRewardLine } from '@/lib/arc-reflection-rewards'
import { fmtUsd } from '@/lib/ui-format'

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

export default function PortfolioPage() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

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
    if (!address) {
      setPortfolio(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/arc/portfolio/${address}`, { cache: 'no-store' })
      const data = (await res.json()) as {
        ok?: boolean
        portfolio?: PortfolioPayload
        error?: string
      }
      if (!res.ok || !data.ok || !data.portfolio) {
        setError(data.error || 'Failed to load portfolio')
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
  }, [address])

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

  const claimableLines =
    portfolio?.reflectionLines.filter((l) => l.claimableHuman > 0 && l.isUsdcReward) ?? []

  if (!isConnected || !address) {
    return (
      <main className="min-h-screen text-white pt-16 pb-20">
        <div className="max-w-desk mx-auto px-4 sm:px-10 py-16 flex flex-col items-center gap-4">
          <h1 className="m-0 text-[28px] font-semibold tracking-tightish">Portfolio</h1>
          <p className="m-0 text-t2 text-sm text-center max-w-md">
            Connect your wallet to see USDC rewards from Instant Reflection tokens you hold.
          </p>
          <button
            type="button"
            disabled={connecting}
            onClick={() => connectors[0] && connect({ connector: connectors[0] })}
            className="h-11 px-6 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50"
          >
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        </div>
      </main>
    )
  }

  const claimable = portfolio?.usdcRewards.claimable ?? 0
  const pending = portfolio?.usdcRewards.pending ?? 0
  const earned = portfolio?.usdcRewards.earned ?? 0
  const claimed = portfolio?.usdcRewards.claimed ?? 0

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="m-0 text-[28px] font-semibold tracking-tightish">Portfolio</h1>
            <p className="m-0 mt-1 text-sm text-t3 tabular-nums">
              {address.slice(0, 6)}…{address.slice(-4)}
              {wrongChain ? (
                <span className="ml-2 text-amber-300">· wrong network</span>
              ) : null}
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

        {error ? (
          <p className="mb-4 text-sm text-coral">{error}</p>
        ) : null}

        {/* Tiles */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
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

        {portfolio?.usdcRewards.otherClaimable?.length ? (
          <p className="mb-4 text-sm text-t3">
            Also claimable (non-USDC):{' '}
            {portfolio.usdcRewards.otherClaimable
              .map((o) => `${o.amount.toFixed(4)} ${o.symbol}`)
              .join(' · ')}
          </p>
        ) : null}

        {/* Breakdown */}
        <section className="border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-4 border-b border-hair2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 text-[17px] font-semibold tracking-tightish">
                Reflection rewards by token
              </h2>
              <p className="m-0 mt-0.5 text-[13px] text-t3">
                Checked {portfolio?.tokensChecked ?? 0} reflection launches · claim is per-token
              </p>
            </div>
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
    </main>
  )
}
