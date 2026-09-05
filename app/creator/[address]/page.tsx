'use client'

/**
 * Public creator profile — coins, fees claim, edit profile, follow, trading PnL.
 */
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  useAccount,
  useSignMessage,
  useWriteContract,
  useWaitForTransactionReceipt,
  useConnect,
} from 'wagmi'
import { Loader2, ExternalLink, Copy, Check, Share2, UserPlus, UserMinus } from 'lucide-react'
import type { PoolToken } from '@/lib/tokens'
import type { CreatorProfile } from '@/lib/arc-creator'
import type { CreatorMeta } from '@/lib/arc-creator-meta'
import type { CreatorFeePosition } from '@/lib/arc-creator-fees'
import type { CreatorPnl } from '@/lib/arc-creator-pnl'
import { MONLOCK_COLLECT_ABI } from '@/lib/arc-creator-fees'
import { profileEditMessage, followMessage } from '@/lib/arc-auth'
import { uploadImage } from '@/lib/upload-image'
import { ARC_EXPLORER, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { ageLabel, fmtUsd, tileGradient } from '@/lib/ui-format'
import { formatToken } from '@/lib/token-format'
import { PortfolioDesk } from '@/components/PortfolioDesk'
import type { Address } from 'viem'
import { cdnImage } from '@/lib/cdn-image'

type PnlRange = CreatorPnl['range']

/** lib/arc-eve-holder-rewards.ts EVE_TOKEN, duplicated here rather than imported — that module
 *  pulls in server-only deps (private-key signing, @vercel/kv) that a client component must
 *  never bundle, even if the actual server-side code would tree-shake away. */
const EVE_TOKEN = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF'

function fmtCool(raw: bigint): string {
  const n = Number(formatToken(raw, 18))
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return n.toPrecision(3)
}

export default function CreatorPage() {
  const params = useParams()
  const raw = ((params?.address as string) ?? '').trim()
  const { address: connected, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { signMessageAsync } = useSignMessage()

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [q, setQ] = useState('')
  const [pnlRange, setPnlRange] = useState<PnlRange>('1W')
  const [viewerFollowing, setViewerFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [claimPosId, setClaimPosId] = useState<string | null>(null)
  const [claimLocker, setClaimLocker] = useState<Address | null>(null)

  const {
    writeContract,
    data: claimTx,
    isPending: claimPending,
    error: claimErr,
    reset: resetClaim,
  } = useWriteContract()
  const { isLoading: claimConfirming, isSuccess: claimOk } = useWaitForTransactionReceipt({
    hash: claimTx,
  })

  const load = useCallback(async () => {
    if (!raw) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/arc/creator/${raw}?pnl=${pnlRange}`, { cache: 'no-store' })
      const data = (await res.json()) as { ok?: boolean; profile?: CreatorProfile; error?: string }
      if (!res.ok || !data.ok || !data.profile) {
        setError(data.error || 'Creator not found')
        setProfile(null)
        return
      }
      setProfile(data.profile)
    } catch (e) {
      setError((e as Error).message)
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [raw, pnlRange])

  const loadFollowState = useCallback(async () => {
    if (!raw || !connected) {
      setViewerFollowing(false)
      return
    }
    try {
      const res = await fetch(
        `/api/arc/creator/${raw}/follow?viewer=${connected}`,
        { cache: 'no-store' },
      )
      const data = (await res.json()) as { viewerFollowing?: boolean }
      setViewerFollowing(Boolean(data.viewerFollowing))
    } catch {
      setViewerFollowing(false)
    }
  }, [raw, connected])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadFollowState()
  }, [loadFollowState])

  useEffect(() => {
    if (claimOk) {
      void load()
      resetClaim()
      setClaimPosId(null)
      setClaimLocker(null)
    }
  }, [claimOk, load, resetClaim])

  // $EVE holder-rewards tile (see lib/arc-eve-holder-rewards.ts) — only meaningful for the
  // connected wallet's own profile, so this deliberately checks `connected` against
  // `profile.address` directly rather than waiting on `isSelf` below (hooks run before it).
  const [coolRewards, setCoolRewards] = useState<{
    claimed: bigint
    ended: boolean
    expiresAt: number | null
  } | null>(null)

  const loadCoolRewards = useCallback(async () => {
    if (!connected || !profile || connected.toLowerCase() !== profile.address.toLowerCase()) {
      setCoolRewards(null)
      return
    }
    try {
      const res = await fetch(
        `/api/arc/keeper/eve-holder-rewards?status=1&wallet=${connected}`,
        { cache: 'no-store' },
      )
      const data = (await res.json()) as {
        ok?: boolean
        walletClaimed?: string
        state?: { ended?: boolean; expiresAt?: number }
      }
      if (!data.ok) {
        setCoolRewards(null)
        return
      }
      setCoolRewards({
        claimed: data.walletClaimed ? BigInt(data.walletClaimed) : 0n,
        ended: Boolean(data.state?.ended),
        expiresAt: data.state?.expiresAt ?? null,
      })
    } catch {
      setCoolRewards(null)
    }
  }, [connected, profile])

  useEffect(() => {
    void loadCoolRewards()
  }, [loadCoolRewards])

  const isSelf =
    !!connected &&
    !!profile &&
    connected.toLowerCase() === profile.address.toLowerCase()

  const filtered = useMemo(() => {
    const tokens = profile?.tokens ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return tokens
    return tokens.filter((t) => {
      const hay = `${t.name} ${t.symbol} ${t.coinType} ${t.poolId}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [profile, q])

  const copyAddr = useCallback(() => {
    if (!profile) return
    navigator.clipboard
      .writeText(profile.addressChecksum)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [profile])

  const share = useCallback(() => {
    if (!profile || typeof window === 'undefined') return
    const url = window.location.href
    if (navigator.share) {
      void navigator.share({ title: `Creator ${profile.short} on Arcfun`, url }).catch(() => {
        void navigator.clipboard.writeText(url)
      })
    } else {
      void navigator.clipboard.writeText(url)
    }
  }, [profile])

  const onFollow = async () => {
    if (!connected || !profile) {
      if (connectors[0]) connect({ connector: connectors[0] })
      return
    }
    if (chainId !== ARC_CHAIN_ID) {
      alert('Switch to Arc mainnet first')
      return
    }
    setFollowBusy(true)
    try {
      const action = viewerFollowing ? 'unfollow' : 'follow'
      const timestamp = Date.now()
      const message = followMessage(connected, profile.addressChecksum, action, timestamp)
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/arc/creator/${profile.addressChecksum}/follow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          follower: connected,
          action,
          signature,
          timestamp,
        }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        followers?: number
        following?: number
        viewerFollowing?: boolean
      }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Follow failed')
      setViewerFollowing(Boolean(data.viewerFollowing))
      setProfile((p) =>
        p
          ? {
              ...p,
              followers: data.followers ?? p.followers,
              following: data.following ?? p.following,
            }
          : p,
      )
    } catch (e) {
      alert((e as Error).message || 'Follow failed')
    } finally {
      setFollowBusy(false)
    }
  }

  const onCollect = (pos: CreatorFeePosition) => {
    if (!isConnected) {
      if (connectors[0]) connect({ connector: connectors[0] })
      return
    }
    if (chainId !== ARC_CHAIN_ID) {
      alert('Switch to Arc mainnet first')
      return
    }
    setClaimPosId(pos.positionId)
    setClaimLocker(pos.locker)
    writeContract({
      address: pos.locker,
      abi: MONLOCK_COLLECT_ABI,
      functionName: 'collectFees',
      args: [BigInt(pos.positionId)],
      chainId: ARC_CHAIN_ID,
    })
  }

  const explorer = ARC_EXPLORER || 'https://arc-scan.org'
  const seed = profile?.addressChecksum || raw || 'creator'
  const { tile, mono } = tileGradient(seed)
  const displayName = profile?.meta?.displayName?.trim() || profile?.short || 'Creator'
  const avatar = profile?.meta?.avatarUrl
  const twitter = profile?.meta?.twitter

  if (loading && !profile) {
    return (
      <main className="min-h-screen text-white flex items-center justify-center pt-16">
        <Loader2 className="w-8 h-8 animate-spin text-lime-t" />
      </main>
    )
  }

  if (error || !profile) {
    return (
      <main className="min-h-screen text-white flex flex-col items-center justify-center gap-4 px-4 pt-16">
        <p className="text-t2">{error || 'Creator not found'}</p>
        <Link href="/" className="text-lime-t hover:text-white text-sm font-semibold">
          ← Home
        </Link>
      </main>
    )
  }

  const pnl = profile.pnl
  const pnlUp = (pnl?.realizedUsd ?? 0) >= 0

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-6 sm:py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        {/* Header */}
        <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 mb-5">
          <div className="flex flex-col sm:flex-row sm:items-start gap-5">
            <span
              className="relative w-[72px] h-[72px] rounded-full shrink-0 overflow-hidden flex items-center justify-center text-[28px] font-bold tracking-[-0.04em]"
              style={{ background: avatar ? undefined : tile, color: mono }}
            >
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cdnImage(avatar, 128)} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                profile.short.slice(2, 4).toUpperCase()
              )}
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5 mb-1">
                <h1 className="m-0 text-[22px] sm:text-[26px] font-semibold tracking-tightish truncate">
                  {displayName}
                </h1>
                {isSelf && (
                  <span className="px-2 py-0.5 rounded-lg bg-lime-soft text-lime-t text-[11px] font-semibold">
                    You
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-t3 mb-2">
                <span className="tabular-nums font-medium text-t2">
                  {profile.followers} Followers
                </span>
                <span className="tabular-nums font-medium text-t2">
                  {profile.following} Following
                </span>
                {twitter ? (
                  <a
                    href={`https://x.com/${twitter}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-lime-t"
                  >
                    @{twitter}
                  </a>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-t3">
                <button
                  type="button"
                  onClick={copyAddr}
                  className="inline-flex items-center gap-1 hover:text-t2 tabular-nums"
                  title={copied ? 'Copied!' : 'Copy address'}
                >
                  {profile.short}
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-lime-t" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                <a
                  href={`${explorer}/address/${profile.addressChecksum}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-lime-t"
                >
                  Explorer <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              {profile.meta?.bio ? (
                <p className="m-0 mt-3 text-sm text-t2 max-w-xl whitespace-pre-wrap">{profile.meta.bio}</p>
              ) : (
                <p className="m-0 mt-3 text-sm text-t3 max-w-xl">
                  Tokens launched on Arcfun · Instant, Reflection, and curve.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                type="button"
                onClick={share}
                className="inline-flex h-10 items-center gap-2 px-4 rounded-xl border border-hair bg-s2 text-sm font-semibold hover:border-lime-line transition-colors"
              >
                <Share2 className="w-4 h-4" /> Share
              </button>
              {isSelf ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    className="inline-flex h-10 items-center px-4 rounded-xl border border-hair bg-s2 text-sm font-semibold hover:border-lime-line transition-colors"
                  >
                    Edit profile
                  </button>
                  <Link
                    href="/create"
                    className="inline-flex h-10 items-center px-4 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 transition-colors"
                  >
                    + Create coin
                  </Link>
                </>
              ) : (
                <button
                  type="button"
                  disabled={followBusy || connecting}
                  onClick={() => void onFollow()}
                  className="inline-flex h-10 items-center gap-2 px-4 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50 transition-colors"
                >
                  {followBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : viewerFollowing ? (
                    <UserMinus className="w-4 h-4" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  {viewerFollowing ? 'Unfollow' : 'Follow'}
                </button>
              )}
            </div>
          </div>
        </section>

        {isSelf ? <PortfolioDesk wallet={profile.address} /> : null}

        {isSelf && coolRewards ? (
          <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 mb-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <h2 className="m-0 text-[17px] font-semibold tracking-tightish">
                  $COOL holder rewards
                </h2>
                <p className="m-0 mt-1 text-[13px] text-t3 max-w-lg">
                  A share of $EVE&apos;s platform LP fees, swapped into $COOL and sent to every
                  EVE holder automatically.{' '}
                  {coolRewards.ended
                    ? 'This program has ended.'
                    : coolRewards.expiresAt
                      ? `Runs through ${new Date(coolRewards.expiresAt).toLocaleDateString()}.`
                      : null}
                </p>
              </div>
              <div className="text-left sm:text-right shrink-0">
                <p className="m-0 text-[22px] font-semibold tabular-nums tracking-tightish text-lime-t">
                  {fmtCool(coolRewards.claimed)}{' '}
                  <span className="text-[14px] font-medium text-t3">COOL</span>
                </p>
                <p className="m-0 mt-0.5 text-[12px] text-t3">received so far</p>
              </div>
            </div>
            <Link
              href={`/token/${EVE_TOKEN}`}
              className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-t3 hover:text-white"
            >
              View $EVE <ExternalLink className="h-3 w-3" />
            </Link>
          </section>
        ) : null}

        {/* PnL */}
        <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">
              Trading P&L
            </p>
            <div className="flex gap-1 p-0.5 rounded-lg bg-s2 border border-hair">
              {(['1D', '1W', '1M', 'ALL'] as PnlRange[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setPnlRange(r)}
                  className={`px-2.5 py-1 rounded-md text-[12px] font-semibold transition-colors ${
                    pnlRange === r ? 'bg-s3 text-white' : 'text-t3 hover:text-t2'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <p
            className="m-0 text-[36px] sm:text-[42px] font-bold tracking-tightish tabular-nums"
            style={{ color: pnlUp ? 'var(--limeT)' : 'var(--coral)' }}
          >
            {pnl
              ? `${pnlUp ? '' : '−'}$${Math.abs(pnl.realizedUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : '—'}
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniStat
              label="Buy volume"
              value={pnl ? fmtUsd(pnl.buyVolumeUsd) : '—'}
            />
            <MiniStat
              label="Sell volume"
              value={pnl ? fmtUsd(pnl.sellVolumeUsd) : '—'}
            />
            <MiniStat
              label="Trades"
              value={pnl ? String(pnl.tradesSampled) : '—'}
            />
          </div>
          {pnl?.note ? (
            <p className="m-0 mt-3 text-[12px] text-t3">{pnl.note}</p>
          ) : null}
        </section>

        {/* Stats row */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          <StatCard
            label="Coins created"
            value={String(profile.coinsCreated)}
            sub={profile.coinsCreated === 1 ? '1 launch' : `${profile.coinsCreated} launches`}
          />
          <StatCard
            label="Top coin"
            value={profile.topCoin?.symbol || '—'}
            sub={profile.topCoin ? fmtUsd(profile.topCoin.marketCap) + ' MC' : 'No launches yet'}
            href={profile.topCoin ? `/token/${profile.topCoin.address}` : undefined}
          />
          <StatCard
            label="Total MC"
            value={fmtUsd(profile.totalMarketCap)}
            sub={
              profile.latest
                ? `Latest · ${profile.latest.symbol}${profile.latest.createdAt ? ` · ${ageLabel(profile.latest.createdAt)}` : ''}`
                : 'Combined market caps'
            }
          />
        </section>

        {/* Fee claim */}
        <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Creator LP fees</h2>
              <p className="m-0 mt-1 text-[13px] text-t3 max-w-lg">
                Quote-side USDC split to the rewards wallet stamped at launch. Collect is
                permissionless. Pending is still in the LP NFT. Collected already landed in
                that wallet.
              </p>
            </div>
            {profile.feePositions.length > 0 ? (
              <div className="text-left sm:text-right shrink-0">
                <p className="m-0 text-[22px] font-semibold tabular-nums tracking-tightish text-lime-t">
                  {fmtUsd(
                    profile.feePositions.reduce(
                      (n, p) => n + (p.pendingCreatorUsdc ?? 0) + (p.collectedCreatorUsdc ?? 0),
                      0,
                    ),
                  )}
                </p>
                <p className="m-0 mt-0.5 text-[12px] text-t3 tabular-nums">
                  earned
                  {' · '}
                  {fmtUsd(
                    profile.feePositions.reduce((n, p) => n + (p.pendingCreatorUsdc ?? 0), 0),
                  )}{' '}
                  pending
                  {' · '}
                  {fmtUsd(
                    profile.feePositions.reduce((n, p) => n + (p.collectedCreatorUsdc ?? 0), 0),
                  )}{' '}
                  collected
                </p>
              </div>
            ) : null}
          </div>
          {profile.feePositions.length === 0 ? (
            <p className="m-0 text-sm text-t3">No locked LP positions found for this creator.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {profile.feePositions.map((pos) => {
                const busy =
                  (claimPending || claimConfirming) && claimPosId === pos.positionId
                const pending = pos.pendingCreatorUsdc ?? 0
                const collected = pos.collectedCreatorUsdc ?? 0
                return (
                  <li
                    key={`${pos.locker}-${pos.positionId}`}
                    className="flex flex-wrap items-center gap-3 justify-between border border-hair2 rounded-2xl px-4 py-3 bg-s2/40"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/token/${pos.token}`}
                        className="font-semibold tracking-tightish hover:text-lime-t"
                      >
                        {pos.name || pos.symbol}{' '}
                        <span className="text-t3 font-medium">${pos.symbol}</span>
                      </Link>
                      <p className="m-0 mt-0.5 text-[12px] text-t3 tabular-nums">
                        Position #{pos.positionId}
                        {pos.creatorBps > 0 ? ` · creator ${pos.creatorBps / 100}%` : ''}
                        {pending > 0 ? ` · ${fmtUsd(pending)} pending` : ''}
                        {collected > 0 ? ` · ${fmtUsd(collected)} collected` : ''}
                        {pending <= 0 && collected <= 0 ? ' · no fees yet' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onCollect(pos)}
                      className="shrink-0 inline-flex h-9 items-center px-3.5 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Collecting…
                        </>
                      ) : pending > 0.001 ? (
                        `Collect ${fmtUsd(pending)}`
                      ) : (
                        'Collect fees'
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {claimErr ? (
            <p className="m-0 mt-3 text-[13px] text-coral">{claimErr.message}</p>
          ) : null}
          {claimOk && claimLocker ? (
            <p className="m-0 mt-3 text-[13px] text-lime-t">Fees collected.</p>
          ) : null}
        </section>

        {/* Created coins */}
        <section className="border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 border-b border-hair2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Created coins</h2>
              <span className="px-2 py-0.5 rounded-full bg-s3 text-[12px] font-semibold tabular-nums text-t2">
                {profile.coinsCreated}
              </span>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search coins…"
              className="h-9 w-full sm:w-[220px] px-3 rounded-xl bg-s2 border border-hair text-sm outline-none placeholder:text-white/25 focus:border-lime-line"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-t3 text-sm">
              {profile.coinsCreated === 0
                ? 'No tokens launched from this wallet yet.'
                : 'No coins match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[12px] font-semibold text-t3 border-b border-hair2">
                    <th className="px-5 py-3 font-semibold">Coin</th>
                    <th className="px-5 py-3 font-semibold text-right">MC</th>
                    <th className="px-5 py-3 font-semibold text-right hidden sm:table-cell">Price</th>
                    <th className="px-5 py-3 font-semibold text-right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <CoinRow key={t.coinType || t.poolId || t.id} token={t} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {editOpen && profile && (
        <EditProfileModal
          address={profile.addressChecksum}
          initial={profile.meta || {}}
          onClose={() => setEditOpen(false)}
          onSaved={(meta) => {
            setProfile((p) => (p ? { ...p, meta } : p))
            setEditOpen(false)
          }}
        />
      )}
    </main>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">{label}</p>
      <p className="m-0 mt-1 text-[15px] font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string
  value: string
  sub: string
  href?: string
}) {
  const inner = (
    <>
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">{label}</p>
      <p className="m-0 mt-2 text-[26px] font-semibold tracking-tightish tabular-nums truncate">{value}</p>
      <p className="m-0 mt-1 text-[13px] text-t3 truncate">{sub}</p>
    </>
  )
  const cls =
    'block border border-hair rounded-[20px] bg-s1 px-5 py-4 transition-colors' +
    (href ? ' hover:border-lime-line' : '')
  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    )
  }
  return <div className={cls}>{inner}</div>
}

function CoinRow({ token }: { token: PoolToken }) {
  const address = token.coinType || token.poolId || token.id
  const seed = address || token.symbol || token.name
  const { tile, mono } = tileGradient(seed)
  const initial = (token.symbol || token.name || '?').charAt(0).toUpperCase()
  const img = token.imageUrl || token.logoUrl
  const age = ageLabel(token.createdAt)

  return (
    <tr className="border-b border-hair2 last:border-0 hover:bg-white/[0.02]">
      <td className="px-5 py-3.5">
        <Link href={`/token/${address}`} className="flex items-center gap-3 min-w-0 group">
          <span
            className="relative w-10 h-10 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-sm font-bold"
            style={{ background: img ? undefined : tile, color: mono }}
          >
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cdnImage(img, 128)} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              initial
            )}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold tracking-tightish truncate group-hover:text-lime-t">
              {token.name || 'Unnamed'}
            </span>
            <span className="block text-[12px] text-t3 tabular-nums">${token.symbol}</span>
          </span>
        </Link>
      </td>
      <td className="px-5 py-3.5 text-right font-semibold tabular-nums">{fmtUsd(token.marketCap)}</td>
      <td className="px-5 py-3.5 text-right tabular-nums text-t2 hidden sm:table-cell">
        {fmtUsd(token.currentPrice)}
      </td>
      <td className="px-5 py-3.5 text-right text-t3 tabular-nums">{age}</td>
    </tr>
  )
}

function EditProfileModal({
  address,
  initial,
  onClose,
  onSaved,
}: {
  address: string
  initial: CreatorMeta
  onClose: () => void
  onSaved: (meta: CreatorMeta) => void
}) {
  const { signMessageAsync } = useSignMessage()
  const [displayName, setDisplayName] = useState(initial.displayName || '')
  const [bio, setBio] = useState(initial.bio || '')
  const [twitter, setTwitter] = useState(initial.twitter || '')
  const [avatarUrl, setAvatarUrl] = useState(initial.avatarUrl || '')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onFile = async (file: File | null) => {
    if (!file) return
    setUploading(true)
    setErr(null)
    try {
      const url = await uploadImage(file, 'creator-avatars')
      setAvatarUrl(url)
    } catch (e) {
      setErr((e as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      const timestamp = Date.now()
      const message = profileEditMessage(address, timestamp)
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/arc/creator/${address}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          signature,
          timestamp,
          displayName,
          bio,
          twitter,
          avatarUrl,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; meta?: CreatorMeta; error?: string }
      if (!res.ok || !data.ok || !data.meta) throw new Error(data.error || 'Save failed')
      onSaved(data.meta)
    } catch (e) {
      setErr((e as Error).message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md border border-hair rounded-[24px] bg-s1 p-5 sm:p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="m-0 text-lg font-semibold">Edit profile</h2>
          <button type="button" onClick={onClose} className="text-t3 hover:text-white text-sm">
            Close
          </button>
        </div>

        <div className="flex items-center gap-4 mb-4">
          <span className="relative w-16 h-16 rounded-full overflow-hidden bg-s3 shrink-0">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cdnImage(avatarUrl, 128)} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : null}
          </span>
          <label className="inline-flex h-9 items-center px-3 rounded-xl border border-hair text-sm font-semibold cursor-pointer hover:border-lime-line">
            {uploading ? 'Uploading…' : 'Upload avatar'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={uploading}
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <label className="block mb-3">
          <span className="text-[12px] font-semibold text-t3">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={48}
            className="mt-1 w-full h-10 px-3 rounded-xl bg-s2 border border-hair text-sm outline-none focus:border-lime-line"
            placeholder="Name"
          />
        </label>
        <label className="block mb-3">
          <span className="text-[12px] font-semibold text-t3">Bio</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            rows={3}
            className="mt-1 w-full px-3 py-2 rounded-xl bg-s2 border border-hair text-sm outline-none focus:border-lime-line resize-none"
            placeholder="About you"
          />
        </label>
        <label className="block mb-4">
          <span className="text-[12px] font-semibold text-t3">X (Twitter)</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-t3 text-sm">@</span>
            <input
              value={twitter}
              onChange={(e) => setTwitter(e.target.value.replace(/^@/, ''))}
              maxLength={32}
              className="flex-1 h-10 px-3 rounded-xl bg-s2 border border-hair text-sm outline-none focus:border-lime-line"
              placeholder="handle"
            />
          </div>
        </label>

        {err ? <p className="m-0 mb-3 text-[13px] text-coral">{err}</p> : null}

        <button
          type="button"
          disabled={saving || uploading}
          onClick={() => void save()}
          className="w-full h-11 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50"
        >
          {saving ? 'Signing & saving…' : 'Save profile'}
        </button>
        <p className="m-0 mt-2 text-[11px] text-t3 text-center">
          You&apos;ll sign a message to prove you own this wallet. No gas.
        </p>
      </div>
    </div>
  )
}
