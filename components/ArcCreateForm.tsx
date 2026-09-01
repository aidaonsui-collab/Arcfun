'use client'

/**
 * Launch on Arc — Instant or Instant Reflection (both TOKEN/USDC + holder rewards path).
 */
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain, useWriteContract, useSignMessage } from 'wagmi'
import { erc20Abi, getAddress, isAddress, type Address } from 'viem'
import { prepareTokenRegisterAuth } from '@/lib/arc-auth'
import { Loader2, AlertCircle, CheckCircle, ImagePlus } from 'lucide-react'
import {
  ARC,
  ARC_CHAIN_ID,
  ARC_INSTANT_CREATE_GAS,
  arcInstantEnabled,
  arcReflectionEnabled,
  arcLaunchesEnabled,
  arcCreationFeeWeiFor,
  factoryUsesCrucibleLock,
} from '@/lib/contracts-arc'
import {
  buildCreateTokenMemeInstantArc,
  parseArcQuote,
} from '@/lib/arc-instant-launchpad'
import { liveRwaQuoteAssets, pendingRwaQuoteAssets, rwaAssetById } from '@/lib/arc-rwa-assets'
import {
  buildCreateTokenReflectionArc,
  ARC_REFLECTION_CREATE_GAS,
} from '@/lib/arc-reflection-launchpad'
import { waitArcCreateConfirmed } from '@/lib/arc-wait-create'
import { uploadImage } from '@/lib/upload-image'
import { tileGradient } from '@/lib/ui-format'
import { CrucibleFeePath } from '@/components/CrucibleFeePath'
import { prefillFromSearch, type BlitzPrefill } from '@/lib/arc-blitz'

type Step = 'idle' | 'uploading' | 'approving' | 'creating' | 'confirming' | 'registering' | 'done'
type LaunchType = 'instant' | 'reflection'

const LAUNCH_TYPES: {
  key: LaunchType
  icon: string
  title: string
  tagline: string
  points: string[]
}[] = [
  {
    key: 'instant',
    icon: '⚡',
    title: 'Meme Launch',
    tagline: 'Tradable from block one',
    points: [
      'Full supply onto Uniswap V3 at creation',
      'Crucible buys and burns $EVE from quote fees',
      'Launch-token LP fees auto-burned',
    ],
  },
  {
    key: 'reflection',
    icon: '◈',
    title: 'Reflection token',
    tagline: 'LP fees pay your holders',
    points: [
      'Holders earn a 20% quote-fee leg via reflect()',
      'Crucible is the $EVE holder reward — not pad-wide USDC',
      'Instant TOKEN/USDC pool from block one',
    ],
  },
]

const FIRST_BUY_PRESETS = ['100', '250', '1000']

export function ArcCreateForm({
  initial,
  compact = false,
}: {
  initial?: BlitzPrefill
  compact?: boolean
} = {}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signMessageAsync } = useSignMessage()

  const [launchType, setLaunchType] = useState<LaunchType>('instant')
  /** Instant quote asset. `usdc` is the live factory; an RWA id is plug-and-play. */
  const [quoteId, setQuoteId] = useState('usdc')
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string>('')
  const [imageRemote, setImageRemote] = useState<string>('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [rewardsWallet, setRewardsWallet] = useState('')
  /** Holder reward ERC-20 — default Arc USDC (6dp). Pool quote is always USDC. */
  const [rewardToken, setRewardToken] = useState<string>(ARC.USDC)
  const [buyAtLaunch, setBuyAtLaunch] = useState(false)
  const [firstBuy, setFirstBuy] = useState('250')

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Set only when the on-chain create succeeded but the off-chain name/image/socials write
  // (a signed, separate step — see prepareTokenRegisterAuth) failed or the creator dismissed
  // that second wallet prompt. The token is already live either way; this just remembers enough
  // to retry the metadata write without asking the creator to fill the form out again.
  const [pendingRegister, setPendingRegister] = useState<{
    token: Address
    payload: Record<string, unknown>
  } | null>(null)
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const configured = arcInstantEnabled()
  const reflectionLive = arcReflectionEnabled()
  /** Public creates on by default; set NEXT_PUBLIC_ARC_LAUNCHES_ENABLED=0 to pause. */
  const launchesLive = arcLaunchesEnabled()
  const busy = step !== 'idle' && step !== 'done'
  const liveRwas = liveRwaQuoteAssets()
  const pendingRwas = pendingRwaQuoteAssets()
  const rwaQuote = quoteId !== 'usdc' ? rwaAssetById(quoteId) : null
  const quoteSymbol = rwaQuote?.symbol || 'USDC'
  const isReflection = launchType === 'reflection'
  const rewardsOk =
    !rewardsWallet.trim() || isAddress(rewardsWallet.trim() as Address)
  const rewardTokenOk = isAddress(rewardToken)

  const seed = symbol || name || 'new'
  const { tile, mono } = useMemo(() => tileGradient(seed), [seed])
  const previewInitial = (symbol || name || '?').charAt(0).toUpperCase()

  const onPickImage = (f: File | null) => {
    setImageFile(f)
    setImageRemote('')
    setImagePreview(f ? URL.createObjectURL(f) : '')
  }

  const applyPrefill = (p: BlitzPrefill) => {
    if (p.name) setName(p.name)
    if (p.symbol) setSymbol(p.symbol)
    if (p.description) setDescription(p.description)
    if (p.twitter) setTwitter(p.twitter)
    if (p.website) setWebsite(p.website)
    if (p.imageUrl) {
      setImageFile(null)
      setImageRemote(p.imageUrl)
      setImagePreview(`/api/arc/blitz/media?u=${encodeURIComponent(p.imageUrl)}`)
    } else {
      setImageFile(null)
      setImageRemote('')
      setImagePreview('')
    }
    setLaunchType('instant')
  }

  useEffect(() => {
    if (initial) {
      applyPrefill(initial)
      return
    }
    if (compact) return
    try {
      const p = prefillFromSearch(new URLSearchParams(window.location.search))
      if (p) applyPrefill(p)
    } catch {
      /* ignore */
    }
    // Blitz desk passes a new `initial` when the picked tweet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, compact])

  /** Signs + POSTs the off-chain name/image/socials record. Returns false rather than throwing —
   *  callers decide what "the creator never got to sign, or the write failed" means for the UI. */
  const submitRegister = async (token: Address, payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const prepared = prepareTokenRegisterAuth(token, payload)
      const signature = await signMessageAsync({ message: prepared.message })
      const res = await fetch('/api/arc/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          signature,
          timestamp: prepared.timestamp,
          nonce: prepared.nonce,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null
        setRegisterError(j?.error || `save failed (${res.status})`)
        return false
      }
      setRegisterError(null)
      return true
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      // Most common case in practice: the creator closed the second wallet prompt.
      setRegisterError(ax?.shortMessage || ax?.message || 'signature was not completed')
      return false
    }
  }

  const retryRegister = async () => {
    if (!pendingRegister || registering) return
    setRegistering(true)
    const ok = await submitRegister(pendingRegister.token, pendingRegister.payload)
    setRegistering(false)
    if (ok) setPendingRegister(null)
  }

  const onSubmit = async () => {
    if (!address) return
    if (!launchesLive) {
      setError('Token launches are temporarily paused — check back soon.')
      return
    }
    if (isReflection && !reflectionLive) {
      setError('Reflection factory isn’t live on Arc yet — pick Meme Launch to ship today.')
      return
    }
    if (!rewardsOk) {
      setError('Rewards wallet must be a valid 0x address (or leave blank to use your wallet).')
      return
    }
    if (isReflection && !rewardTokenOk) {
      setError('Reward token must be a valid ERC-20 address (e.g. Arc USDC).')
      return
    }
    // rewardToken may be Arc USDC (holders earn USDC) or any other ERC-20 with a USDC pool.
    setError(null)
    try {
      let imageUrl = ''
      if (imageFile) {
        setStep('uploading')
        imageUrl = await uploadImage(imageFile, 'arcfun')
      } else if (imageRemote) {
        setStep('uploading')
        const imgRes = await fetch(`/api/arc/blitz/media?u=${encodeURIComponent(imageRemote)}`)
        if (!imgRes.ok) throw new Error('Could not pull the tweet image')
        const blob = await imgRes.blob()
        const file = new File([blob], 'blitz.jpg', { type: blob.type || 'image/jpeg' })
        imageUrl = await uploadImage(file, 'arcfun')
      }

      const feeWei = arcCreationFeeWeiFor(address)
      const rewardsAddr =
        rewardsWallet.trim() && isAddress(rewardsWallet.trim() as Address)
          ? (rewardsWallet.trim() as Address)
          : null

      let hash: `0x${string}`
      let token: Address | undefined
      let pool: Address | undefined

      const quoteDecimals = rwaQuote?.decimals || 6
      const firstBuyQuote =
        buyAtLaunch && firstBuy && Number(firstBuy) > 0 ? parseArcQuote(firstBuy, quoteDecimals) : 0n
      const factory = isReflection
        ? ARC.REFLECTION_FACTORY
        : rwaQuote?.factory
          ? (rwaQuote.factory as Address)
          : ARC.INSTANT_FACTORY
      const quoteToken = (rwaQuote?.address as Address) || ARC.USDC

      if (firstBuyQuote > 0n) {
        setStep('approving')
        await writeContractAsync({
          address: quoteToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [factory, firstBuyQuote],
          chainId: ARC_CHAIN_ID,
        })
      }

      if (isReflection) {
        setStep('creating')
        const call = buildCreateTokenReflectionArc(
          name.trim(),
          symbol.trim(),
          rewardToken as Address,
          firstBuyQuote,
          feeWei,
          rewardsAddr,
        )
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          value: call.value,
          chainId: call.chainId,
          gas: ARC_REFLECTION_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      } else {
        setStep('creating')
        const call = buildCreateTokenMemeInstantArc(
          name.trim(),
          symbol.trim(),
          firstBuyQuote,
          feeWei,
          rewardsAddr,
          isReflection ? undefined : (rwaQuote?.factory as Address | undefined),
        )
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          value: call.value,
          chainId: call.chainId,
          gas: ARC_INSTANT_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      }

      if (!token)
        throw new Error(
          'Token created, but could not read its address from the transaction. Check ArcScan.',
        )

      // No signature, can't meaningfully fail, best-effort — see the route's own comment for why
      // this is safe with zero auth: name/symbol/creator are chain reads, not client claims. This
      // runs BEFORE the signed step below so a token's basic identity never again depends on that
      // second wallet prompt being completed.
      try {
        await fetch('/api/arc/register/identity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: getAddress(token), pool: pool || '' }),
        })
      } catch {
        /* purely a cache warm — every reader already falls back to the same chain reads */
      }

      setStep('registering')
      const registerPayload = {
        token: getAddress(token),
        name: name.trim(),
        symbol: symbol.trim(),
        description: description.trim() || '',
        imageUrl: imageUrl || '',
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        website: website.trim(),
        streamUrl: '',
        pool: pool || '',
      }
      const registered = await submitRegister(token, registerPayload)

      setStep('done')
      if (registered) {
        router.push(`/token/${token}`)
      } else {
        // Do NOT navigate away silently. The token's name/symbol are already safe regardless —
        // written above with no signature required, and every reader falls back to the same live
        // chain reads anyway — so what's actually at risk here is only the image/description/
        // socials, which genuinely do need the creator's signature (arbitrary content, nothing
        // on-chain to check it against). Stay put with a retry banner instead of navigating away
        // as if nothing happened; the creator can still jump to the token page themselves once
        // they've had a chance to fix it, or on purpose if they don't care.
        setPendingRegister({ token, payload: registerPayload })
      }
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(e)
      setError(msg.length > 200 ? msg.slice(0, 200) + '…' : msg)
      setStep('idle')
    }
  }

  const canSubmit =
    launchesLive &&
    isConnected &&
    !wrongChain &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !busy &&
    // step 'done' + a pending metadata retry means the on-chain create already happened —
    // busy alone doesn't cover this window, and without this guard the re-enabled "Launched"
    // button re-runs the whole mint flow (fresh signatures, a second on-chain token) instead of
    // just retrying the metadata save the banner is there for.
    !pendingRegister &&
    rewardsOk &&
    (isReflection
      ? reflectionLive && rewardTokenOk
      : configured)

  if (!configured && !reflectionLive) {
    return (
      <div className="rounded-[22px] border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc launch factories aren&apos;t configured — set NEXT_PUBLIC_ARC_INSTANT_* and/or
        NEXT_PUBLIC_ARC_REFLECTION_*.
      </div>
    )
  }

  const rewardsPreview =
    rewardsWallet.trim() && isAddress(rewardsWallet.trim() as Address)
      ? `${rewardsWallet.trim().slice(0, 6)}…${rewardsWallet.trim().slice(-4)}`
      : 'Your wallet'
  const shipRows = [
    { k: 'Type', v: isReflection ? 'Reflection' : 'Meme' },
    { k: 'Supply', v: '1,000,000,000' },
    { k: 'Pair', v: 'USDC · 1% fee' },
    {
      k: 'LP fees',
      v: isReflection
        ? 'Holders 20 · Crucible 35 · Creator 20 · burn 15 · platform 10'
        : 'Creator 50 · Crucible 30 · burn 10 · platform 10',
    },
    { k: 'Rewards to', v: rewardsPreview },
  ]

  return (
    <div
      className={
        compact
          ? 'grid grid-cols-1 gap-0'
          : launchesLive
            ? 'grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-7 items-start'
            : 'grid grid-cols-1 gap-7 items-start max-w-3xl'
      }
    >
      {/* Main form card */}
      <div className="border border-hair rounded-[28px] bg-s1 p-6 sm:p-8">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">
          {compact ? 'Launch this' : 'Launch your token'}
        </h1>
        <p className="mt-2.5 mb-0 text-[15px] text-t2 leading-relaxed">
          {compact
            ? 'Instant TOKEN/USDC. 1B supply, LP locked. Confirm to mint. We do not send the tx for you.'
            : launchesLive
              ? 'Fixed supply of 1B. One transaction, straight onto Uniswap V3. Launch-token LP fees auto-burn.'
              : 'Fixed supply of 1B · Uniswap V3 Instant + Reflection paths. Public launches opening soon.'}
        </p>
        {!compact ? (
          <p className="mt-2 mb-0 text-[13px] text-t3">
            Have a tweet?{' '}
            <a href="/blitz" className="text-lime-t font-semibold hover:text-white">
              Blitz launch
            </a>{' '}
            fills this form from a post.
          </p>
        ) : initial?.handle ? (
          <p className="mt-2 mb-0 text-[13px] text-lime-t font-semibold">From @{initial.handle}</p>
        ) : null}

        {/* Launch type cards — Meme + Reflection live; set LAUNCHES_ENABLED=0 to gate */}
        <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 mt-[26px] ${compact ? 'hidden' : ''}`}>
          {LAUNCH_TYPES.map((lt) => {
            if (!launchesLive) {
              return (
                <div
                  key={lt.key}
                  className="relative text-left p-5 rounded-[22px] opacity-60 cursor-not-allowed"
                  style={{ background: 'var(--s2)', border: '1px solid var(--hair)' }}
                >
                  <span
                    className="absolute top-4 right-4 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
                  >
                    Soon
                  </span>
                  <span
                    className="flex items-center justify-center w-[38px] h-[38px] rounded-xl text-[17px]"
                    style={{ background: 'rgba(255,255,255,0.06)' }}
                  >
                    {lt.icon}
                  </span>
                  <h3 className="mt-3.5 mb-1 text-[17px] font-semibold tracking-tightish text-white">
                    {lt.title}
                  </h3>
                  <p className="m-0 text-[13px] font-semibold" style={{ color: 'rgba(255,255,255,0.34)' }}>
                    {lt.tagline}
                  </p>
                  <span className="mt-3.5 flex flex-col gap-2">
                    {lt.points.map((p) => (
                      <span
                        key={p}
                        className="text-[13px] leading-snug"
                        style={{ color: 'rgba(255,255,255,0.34)' }}
                      >
                        — {p}
                      </span>
                    ))}
                  </span>
                </div>
              )
            }
            const on = launchType === lt.key && (lt.key !== 'instant' || quoteId === 'usdc')
            return (
              <button
                key={lt.key}
                type="button"
                onClick={() => {
                  setLaunchType(lt.key)
                  setQuoteId('usdc')
                }}
                className="relative text-left p-5 rounded-[22px] transition-all"
                style={{
                  background: on ? '#000' : 'var(--s2)',
                  border: `1px solid ${on ? 'var(--lime)' : 'var(--hair)'}`,
                  boxShadow: on
                    ? '0 0 0 1px var(--lime), 0 14px 44px rgba(38,118,202,0.20)'
                    : 'none',
                }}
              >
                <span
                  className="absolute top-4 right-4 w-[22px] h-[22px] rounded-full flex items-center justify-center text-xs font-extrabold border-[1.5px]"
                  style={{
                    background: on ? 'var(--lime)' : 'transparent',
                    color: on ? '#fff' : 'transparent',
                    borderColor: on ? 'var(--lime)' : 'rgba(255,255,255,0.18)',
                  }}
                >
                  ✓
                </span>
                <span
                  className="flex items-center justify-center w-[38px] h-[38px] rounded-xl text-[17px]"
                  style={{
                    background: on ? 'var(--limeSoft)' : 'rgba(255,255,255,0.06)',
                  }}
                >
                  {lt.icon}
                </span>
                <h3 className="mt-3.5 mb-1 text-[17px] font-semibold tracking-tightish text-white">
                  {lt.title}
                </h3>
                <p
                  className="m-0 text-[13px] font-semibold"
                  style={{ color: on ? 'var(--limeT)' : 'rgba(255,255,255,0.34)' }}
                >
                  {lt.tagline}
                </p>
                <span className="mt-3.5 flex flex-col gap-2">
                  {lt.points.map((p) => (
                    <span
                      key={p}
                      className="text-[13px] leading-snug"
                      style={{
                        color: on ? 'rgba(255,255,255,0.58)' : 'rgba(255,255,255,0.34)',
                      }}
                    >
                      — {p}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}

          {liveRwas.map((a) => {
            const on = launchType === 'instant' && quoteId === a.id
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setLaunchType('instant')
                  setQuoteId(a.id)
                }}
                className="relative text-left p-5 rounded-[22px] transition-all"
                style={{
                  background: on ? '#000' : 'var(--s2)',
                  border: `1px solid ${on ? 'var(--lime)' : 'var(--hair)'}`,
                  boxShadow: on
                    ? '0 0 0 1px var(--lime), 0 14px 44px rgba(38,118,202,0.20)'
                    : 'none',
                }}
              >
                <span
                  className="absolute top-4 right-4 w-[22px] h-[22px] rounded-full flex items-center justify-center text-xs font-extrabold border-[1.5px]"
                  style={{
                    background: on ? 'var(--lime)' : 'transparent',
                    color: on ? '#fff' : 'transparent',
                    borderColor: on ? 'var(--lime)' : 'rgba(255,255,255,0.18)',
                  }}
                >
                  ✓
                </span>
                <span
                  className="flex items-center justify-center w-[38px] h-[38px] rounded-xl text-[17px]"
                  style={{ background: on ? 'var(--limeSoft)' : 'rgba(255,255,255,0.06)' }}
                >
                  🏛
                </span>
                <h3 className="mt-3.5 mb-1 text-[17px] font-semibold tracking-tightish text-white">
                  {a.symbol} paired
                </h3>
                <p
                  className="m-0 text-[13px] font-semibold"
                  style={{ color: on ? 'var(--limeT)' : 'rgba(255,255,255,0.34)' }}
                >
                  Instant TOKEN/{a.symbol}
                </p>
                <span className="mt-3.5 flex flex-col gap-2">
                  {[
                    `Same Instant mint + LP lock, quoted in ${a.symbol}`,
                    a.permissioned
                      ? `Permissioned — wallet must be allowlisted for ${a.symbol}`
                      : 'Same create transaction as USDC Instant',
                  ].map((p) => (
                    <span
                      key={p}
                      className="text-[13px] leading-snug"
                      style={{ color: on ? 'rgba(255,255,255,0.58)' : 'rgba(255,255,255,0.34)' }}
                    >
                      — {p}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}

          {pendingRwas.length > 0 && liveRwas.length === 0 && (
          <div
            className="relative text-left p-5 rounded-[22px] opacity-60 cursor-not-allowed"
            style={{ background: 'var(--s2)', border: '1px solid var(--hair)' }}
          >
            <span
              className="absolute top-4 right-4 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
            >
              Soon
            </span>
            <span
              className="flex items-center justify-center w-[38px] h-[38px] rounded-xl text-[17px]"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              🏛
            </span>
            <h3 className="mt-3.5 mb-1 text-[17px] font-semibold tracking-tightish text-white">
              RWA paired tokens
            </h3>
            <p className="m-0 text-[13px] font-semibold" style={{ color: 'rgba(255,255,255,0.34)' }}>
              {pendingRwas.map((a) => a.symbol).join(' · ')} — waiting on issuer + Instant factory
            </p>
            <span className="mt-3.5 flex flex-col gap-2">
              {['Pair a launch against a real-world asset', 'Same Instant mint + LP lock mechanics'].map((p) => (
                <span key={p} className="text-[13px] leading-snug" style={{ color: 'rgba(255,255,255,0.34)' }}>
                  — {p}
                </span>
              ))}
            </span>
          </div>
          )}
        </div>

        <div className="mt-4">
          <CrucibleFeePath
            kind={isReflection ? 'reflect' : 'meme'}
            notionalUsdc={100}
            showSideToggle={false}
            legacyOnChain={
              isReflection ||
              !factoryUsesCrucibleLock(
                (rwaQuote?.factory as Address | undefined) || ARC.INSTANT_FACTORY,
              )
            }
          />
        </div>

        {!launchesLive ? (
          <div className="mt-6 rounded-[22px] border border-hair bg-s2 px-5 py-6 text-center">
            <p className="m-0 text-[15px] font-semibold tracking-tightish text-white">
              Launches coming soon
            </p>
            <p className="mt-2 mb-0 text-[13px] text-t2 leading-relaxed max-w-md mx-auto">
              Instant, Reflection, and RWA paired launches are paused while we finish polishing.
              Trading existing tokens stays live.
            </p>
          </div>
        ) : (
          <>
        {isReflection && (
          <div className="mt-3 p-5 rounded-[22px] bg-s2 border border-lime-line space-y-4">
            <div className="flex flex-col gap-1">
              <span className="text-[15px] font-semibold tracking-tightish">LP fee split</span>
              <span className="text-[13px] text-t2 leading-snug">
                Quote-side LP fees: <strong className="text-white">20% holders</strong> ·{' '}
                <strong className="text-white">35% Crucible</strong> ·{' '}
                <strong className="text-white">20% creator</strong> ·{' '}
                <strong className="text-white">15% project burn</strong> ·{' '}
                <strong className="text-white">10% platform</strong>. Referrals pay 0.05% on
                Arcfun buys, not from this collect. Launch-token fees burn.
              </span>
              {!reflectionLive ? (
                <span className="text-[12px] text-coral mt-1">
                  Reflection factory not configured — switch to Meme Launch.
                </span>
              ) : (
                <span className="text-[12px] text-lime-t mt-1">
                  Live · TOKEN/USDC pool · factory {ARC.REFLECTION_FACTORY.slice(0, 10)}…
                </span>
              )}
            </div>
            <div>
              <span className="block text-xs font-semibold text-t3 mb-1.5">
                Holder reward token <span className="text-coral">*</span>
              </span>
              <input
                value={rewardToken}
                onChange={(e) => setRewardToken(e.target.value.trim())}
                placeholder="0x… ERC-20 holders earn (default Arc USDC)"
                spellCheck={false}
                className="w-full bg-black/40 border border-hair rounded-xl px-3 py-2.5 text-sm font-mono outline-none focus:border-lime-line"
              />
              <p className="mt-1.5 mb-0 text-[12px] text-t3 leading-snug">
                Defaults to Arc USDC. The trading pair is always TOKEN/USDC; this address is the token
                holders earn when <code className="text-t2">reflect()</code> runs.
              </p>
            </div>
          </div>
        )}

        <div className="h-px bg-hair2 my-7" />

        {/* Image */}
        <div className="flex items-center gap-5">
          <label className="w-24 h-24 rounded-full border-[1.5px] border-dashed border-white/20 bg-s2 flex flex-col items-center justify-center gap-1.5 cursor-pointer shrink-0 overflow-hidden hover:border-lime-line transition-colors">
            {imagePreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imagePreview} alt="" className="w-full h-full object-cover" />
            ) : (
              <>
                <ImagePlus className="w-5 h-5 text-t3" />
                <span className="text-[11px] font-semibold text-t3">Upload</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[17px] font-semibold tracking-tightish">
              Token image <span className="text-coral">*</span>
            </span>
            <span className="text-sm text-t2">PNG or JPG, 256px or larger. Square crops best.</span>
          </div>
        </div>

        {/* Name / ticker */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
          <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-hair">
            <span className="block text-xs font-semibold text-t3 mb-1.5">
              Token name <span className="text-coral">*</span>
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled Token"
              maxLength={64}
              className="w-full bg-transparent border-0 outline-none text-[17px] font-medium tracking-tightish placeholder:text-white/25"
            />
          </div>
          <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-hair">
            <span className="block text-xs font-semibold text-t3 mb-1.5">
              Ticker symbol <span className="text-coral">*</span>
            </span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="$TICKER"
              maxLength={12}
              className="w-full bg-transparent border-0 outline-none text-[17px] font-medium tracking-tightish uppercase placeholder:text-white/25"
            />
          </div>
        </div>

        <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-hair mt-3">
          <span className="block text-xs font-semibold text-t3 mb-1.5">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Say what it is in one line. The internet has a short attention span."
            className="w-full bg-transparent border-0 outline-none resize-none text-[15px] leading-relaxed placeholder:text-white/25"
          />
        </div>

        {/* Socials */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          {[
            { v: twitter, set: setTwitter, ph: '@handle or URL', label: 'X / Twitter' },
            { v: telegram, set: setTelegram, ph: 't.me/…', label: 'Telegram' },
            { v: website, set: setWebsite, ph: 'https://…', label: 'Website' },
          ].map((f) => (
            <div key={f.label} className="px-4 py-3 rounded-[18px] bg-s2 border border-hair">
              <span className="block text-[11px] font-semibold text-t3 mb-1">{f.label}</span>
              <input
                value={f.v}
                onChange={(e) => f.set(e.target.value)}
                placeholder={f.ph}
                className="w-full bg-transparent border-0 outline-none text-sm placeholder:text-white/25"
              />
            </div>
          ))}
        </div>

        {/* LP creator rewards wallet — stamped into ArcLock creator fee leg */}
        <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-hair mt-3">
          <span className="block text-xs font-semibold text-t3 mb-1.5">
            Creator rewards wallet <span className="text-t3 font-normal">(optional)</span>
          </span>
          <input
            value={rewardsWallet}
            onChange={(e) => setRewardsWallet(e.target.value.trim())}
            placeholder={address || '0x… leave blank to use your connected wallet'}
            spellCheck={false}
            className="w-full bg-transparent border-0 outline-none text-[15px] font-mono tracking-tightish placeholder:text-white/25"
          />
          <p className="mt-2 mb-0 text-[12px] text-t3 leading-snug">
            Where your share of LP fees is paid (Instant: ~70% of quote-side fees). Defaults to the
            wallet that signs the create tx.
          </p>
          {rewardsWallet.trim() && !rewardsOk && (
            <p className="mt-1.5 mb-0 text-[12px] text-coral">Enter a valid 0x address.</p>
          )}
        </div>

        {/* Buy at launch */}
        <div className="flex items-center justify-between gap-4 p-[18px] rounded-[18px] bg-s2 border border-hair mt-3">
          <div className="flex flex-col gap-0.5 pr-5">
            <span className="text-[15px] font-semibold tracking-tightish">Buy at launch</span>
            <span className="text-[13px] text-t3 leading-snug">
              Bundle a {quoteSymbol} first buy into the create transaction.
            </span>
          </div>
          <Toggle on={buyAtLaunch} onToggle={() => setBuyAtLaunch((v) => !v)} />
        </div>

        {buyAtLaunch && (
          <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-lime-line mt-3 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-t3">First buy — {quoteSymbol}</span>
              <input
                value={firstBuy}
                onChange={(e) => setFirstBuy(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                className="bg-transparent border-0 outline-none text-[26px] font-semibold tracking-[-0.03em] tabular-nums w-32"
              />
            </div>
            <div className="flex gap-1.5">
              {FIRST_BUY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFirstBuy(p)}
                  className="px-3 py-1.5 rounded-[11px] bg-black border border-hair text-[13px] font-semibold tabular-nums text-t2 hover:text-white"
                >
                  ${p === '1000' ? '1K' : p}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 text-xs text-coral flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
          </p>
        )}

        {pendingRegister && (
          <div className="mt-4 rounded-[14px] border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
            <p className="flex items-start gap-1.5 text-[13px] font-medium text-amber-200">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Token launched — its name and ticker are already live. Its image and socials didn’t
              save{registerError ? ` — ${registerError}` : ''}, though.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={registering}
                onClick={() => void retryRegister()}
                className="h-9 px-4 rounded-[10px] bg-amber-500 text-black text-[13px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
              >
                {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {registering ? 'Retrying…' : 'Retry save'}
              </button>
              <button
                type="button"
                onClick={() => router.push(`/token/${pendingRegister.token}`)}
                className="h-9 px-4 rounded-[10px] border border-hair text-[13px] font-medium text-t2 hover:text-white"
              >
                Skip, view token
              </button>
            </div>
          </div>
        )}

        {!isConnected ? (
          <button
            type="button"
            disabled={connecting}
            onClick={() => connect({ connector: connectors[0] })}
            className="w-full mt-6 h-14 rounded-[18px] bg-lime text-white text-[17px] font-semibold tracking-tightish disabled:opacity-50"
          >
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : wrongChain ? (
          <button
            type="button"
            disabled={switching}
            onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
            className="w-full mt-6 h-14 rounded-[18px] bg-amber-500 text-black text-[17px] font-semibold disabled:opacity-50"
          >
            {switching ? 'Switching…' : 'Switch to Arc'}
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void onSubmit()}
            className="w-full mt-6 h-14 rounded-[18px] bg-lime text-white text-[17px] font-semibold tracking-tightish disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> {stepLabel(step)}
              </>
            ) : step === 'done' ? (
              <>
                <CheckCircle className="w-4 h-4" /> Launched
              </>
            ) : isReflection ? (
              'Launch reflection token'
            ) : (
              'Review launch'
            )}
          </button>
        )}

        <p className="mt-3.5 mb-0 text-xs text-t3 text-center leading-relaxed">
          Creation fee 0.10 USDC · gas on Arc · launch-token LP fees auto-burn · pair USDC
        </p>
          </>
        )}
      </div>

      {/* Sticky preview — only when launches are open */}
      {launchesLive && !compact && (
      <div className="lg:sticky lg:top-[88px] flex flex-col gap-4">
        <div className="border border-hair rounded-[28px] bg-s1 p-5">
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
            Live preview
          </span>
          <div className="mt-3.5 border border-hair rounded-[22px] overflow-hidden bg-black">
            <div
              className="aspect-[16/10] flex items-center justify-center relative"
              style={{ background: imagePreview ? undefined : tile }}
            >
              {imagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imagePreview} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <span className="text-[38px] font-bold" style={{ color: mono }}>
                  {name || symbol ? previewInitial : '?'}
                </span>
              )}
              <span className="absolute top-2.5 left-2.5 px-2 py-1 rounded-[9px] bg-black/55 text-[11px] font-semibold text-white">
                0s
              </span>
              <span className="absolute top-2.5 right-2.5 px-2 py-1 rounded-[9px] bg-black/55 text-[11px] font-semibold text-lime-t">
                {isReflection ? '◈ Reflect' : 'Uni V3'}
              </span>
            </div>
            <div className="px-4 py-3.5 flex flex-col gap-1.5">
              <span className="flex justify-between items-baseline gap-2">
                <span className="text-[15px] font-semibold text-t2 truncate">
                  {name || 'Untitled Token'}
                </span>
                <span className="text-xs font-semibold text-t3 shrink-0">
                  ${symbol || 'TICKER'}
                </span>
              </span>
              <span className="text-[19px] font-semibold tabular-nums tracking-[-0.025em] text-t2">
                $0
              </span>
            </div>
          </div>
        </div>

        <div className="border border-hair rounded-[28px] bg-s1 p-5 flex flex-col gap-3.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3">
            What ships
          </span>
          {shipRows.map((sr) => (
            <span key={sr.k} className="flex justify-between text-sm gap-3">
              <span className="text-t2">{sr.k}</span>
              <span className="font-medium text-right">{sr.v}</span>
            </span>
          ))}
        </div>
      </div>
      )}
    </div>
  )
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="shrink-0 w-[52px] h-8 rounded-full p-0.5 flex transition-[background] duration-200"
      style={{
        background: on ? 'var(--lime)' : 'rgba(255,255,255,0.14)',
        justifyContent: on ? 'flex-end' : 'flex-start',
      }}
      aria-pressed={on}
    >
      <span className="w-7 h-7 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]" />
    </button>
  )
}

function stepLabel(step: Step): string {
  switch (step) {
    case 'uploading':
      return 'Uploading image…'
    case 'approving':
      return 'Approve USDC…'
    case 'creating':
      return 'Confirm in wallet…'
    case 'confirming':
      return 'Waiting for confirmation…'
    case 'registering':
      return 'Saving details…'
    default:
      return 'Working…'
  }
}
