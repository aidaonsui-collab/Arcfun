'use client'

/**
 * Launch on Arc — Instant or Instant Reflection (both TOKEN/USDC + holder rewards path).
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain, useWriteContract, useSignMessage } from 'wagmi'
import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from 'viem'
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
import { fmtUsd } from '@/lib/ui-format'
import { TokenCard } from '@/components/TokenCard'
import { useArcErc20Balance } from '@/lib/use-arc-erc20-balance'
import type { PoolToken } from '@/lib/tokens'
import { prefillFromSearch, type BlitzPrefill } from '@/lib/arc-blitz'

type Step = 'idle' | 'uploading' | 'approving' | 'creating' | 'confirming' | 'registering' | 'done'
type LaunchType = 'instant' | 'reflection'

const LAUNCH_TYPES: {
  key: LaunchType
  title: string
  body: string
}[] = [
  {
    key: 'instant',
    title: 'Meme',
    body: 'Tradable from block one. Quote fees: creator 50 · Crucible 25 · burn 10 · platform 10 · referrer 5.',
  },
  {
    key: 'reflection',
    title: 'Reflect',
    body: 'Holders earn 20% of the quote-fee leg. Crucible is the $EVE holder reward.',
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

  const usdcQ = useArcErc20Balance(ARC.USDC, isConnected && chainId === ARC_CHAIN_ID ? address : undefined)
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
  const feeUsd = Number(arcCreationFeeWeiFor(address)) / 1e18
  const buyUsd = buyAtLaunch ? Number(firstBuy) || 0 : 0
  const payUsd = feeUsd + buyUsd
  const walletUsd =
    usdcQ.data != null ? Number(formatUnits(usdcQ.data, 6)) : null
  const previewToken: PoolToken = {
    id: 'preview',
    poolId: '',
    coinType: '',
    name: name.trim() || 'Untitled',
    symbol: (symbol || 'TICKER').toUpperCase(),
    description: description.trim(),
    imageUrl: imagePreview || '',
    logoUrl: imagePreview || '',
    twitter: twitter.trim(),
    telegram: telegram.trim(),
    website: website.trim(),
    creator: address || '',
    creatorShort: '',
    creatorFull: address || '',
    currentPrice: 0,
    realSuiRaised: 0,
    threshold: 0,
    progress: 100,
    isCompleted: true,
    volume1h: 0,
    priceChange24h: 0,
    age: '0s',
    marketCap: buyUsd,
    totalSupply: 1_000_000_000,
    bondingProgress: 100,
    createdAt: Date.now(),
    instant: true,
    instantLaunch: true,
    reflection: isReflection,
    launchKind: isReflection ? 'reflection' : 'instant',
    instantMeta: { quote: quoteSymbol, isMeme: !isReflection, isRwaBacked: Boolean(rwaQuote) },
  }

  const launchCta = !isConnected
    ? connecting
      ? 'Connecting…'
      : 'Connect to launch'
    : wrongChain
      ? switching
        ? 'Switching…'
        : 'Switch to Arc'
      : busy
        ? stepLabel(step)
        : step === 'done'
          ? 'Launched'
          : 'Launch token'

  const onCta = () => {
    if (!isConnected) {
      connect({ connector: connectors[0] })
      return
    }
    if (wrongChain) {
      switchChain({ chainId: ARC_CHAIN_ID })
      return
    }
    void onSubmit()
  }

  const typePicker = (
    <div className={compact ? 'hidden' : ''}>
      <div className="mb-2 text-xs text-t3">Type</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {LAUNCH_TYPES.map((lt) => (
        <TypeCard
          key={lt.key}
          active={launchType === lt.key && (lt.key !== 'instant' || quoteId === 'usdc')}
          disabled={!launchesLive}
          soon={!launchesLive}
          title={lt.title}
          body={lt.body}
          onClick={
            launchesLive
              ? () => {
                  setLaunchType(lt.key)
                  setQuoteId('usdc')
                }
              : undefined
          }
        />
      ))}
      {liveRwas.map((a) => (
        <TypeCard
          key={a.id}
          active={launchType === 'instant' && quoteId === a.id}
          title={`${a.symbol} paired`}
          body={
            a.permissioned
              ? `Instant TOKEN/${a.symbol}. Permissioned — wallet must be allowlisted.`
              : `Same Instant mint + LP lock, quoted in ${a.symbol}.`
          }
          onClick={() => {
            setLaunchType('instant')
            setQuoteId(a.id)
          }}
        />
      ))}
      {pendingRwas.length > 0 && liveRwas.length === 0 ? (
        <TypeCard
          soon
          disabled
          title="RWA paired tokens"
          body={`${pendingRwas.map((a) => a.symbol).join(' · ')} — waiting on issuer + Instant factory.`}
        />
      ) : null}
      </div>
    </div>
  )

  const fields = (
    <>
        {compact && initial?.handle ? (
          <p className="mt-2 mb-0 text-[13px] text-lime-t font-semibold">From @{initial.handle}</p>
        ) : null}

        {typePicker}

        {!launchesLive ? (
          <div className="mt-6 rounded-[22px] border border-hair bg-s1 px-5 py-6 text-center">
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
              <div className="mt-3 p-5 rounded-2xl bg-s1 border border-lime-line space-y-4">
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
                <Field label="Holder reward token *">
                  <input
                    value={rewardToken}
                    onChange={(e) => setRewardToken(e.target.value.trim())}
                    placeholder="0x… ERC-20 holders earn (default Arc USDC)"
                    spellCheck={false}
                    className={FIELD}
                  />
                  <p className="mt-1.5 mb-0 text-[12px] text-t3 leading-snug">
                    Defaults to Arc USDC. The trading pair is always TOKEN/USDC; this address is the
                    token holders earn when reflect() runs.
                  </p>
                </Field>
              </div>
            )}

            <Field label="Token image *">
              <div className="flex items-center gap-5">
                <label className="w-24 h-24 rounded-full border-[1.5px] border-dashed border-white/20 bg-s1 flex flex-col items-center justify-center gap-1.5 cursor-pointer shrink-0 overflow-hidden hover:border-lime-line transition-colors">
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
                <span className="text-sm text-t2">PNG or JPG, 256px or larger. Square crops best.</span>
              </div>
            </Field>

            <Field label="Name *">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="eve"
                maxLength={64}
                className={FIELD}
              />
            </Field>
            <Field label="Ticker *">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="EVE"
                maxLength={12}
                className={`${FIELD} uppercase`}
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="What is this token."
                className="w-full rounded-2xl bg-s1 px-4 py-3 text-sm outline-none border border-hair focus:border-lime-line placeholder:text-white/30 resize-none"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { v: twitter, set: setTwitter, ph: '@handle or URL', label: 'X / Twitter' },
                { v: telegram, set: setTelegram, ph: 't.me/…', label: 'Telegram' },
                { v: website, set: setWebsite, ph: 'https://…', label: 'Website' },
              ].map((f) => (
                <Field key={f.label} label={f.label}>
                  <input
                    value={f.v}
                    onChange={(e) => f.set(e.target.value)}
                    placeholder={f.ph}
                    className={FIELD}
                  />
                </Field>
              ))}
            </div>

            <Field label="Creator rewards wallet (optional)">
              <input
                value={rewardsWallet}
                onChange={(e) => setRewardsWallet(e.target.value.trim())}
                placeholder={address || '0x… leave blank to use your connected wallet'}
                spellCheck={false}
                className={`${FIELD} font-mono`}
              />
              <p className="mt-2 mb-0 text-[12px] text-t3 leading-snug">
                Where your share of LP fees is paid (Instant: ~70% of quote-side fees). Defaults to the
                wallet that signs the create tx. Rewards to {rewardsPreview}.
              </p>
              {rewardsWallet.trim() && !rewardsOk && (
                <p className="mt-1.5 mb-0 text-[12px] text-coral">Enter a valid 0x address.</p>
              )}
            </Field>

            <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-s1 border border-hair">
              <div className="flex flex-col gap-0.5 pr-5">
                <span className="text-[15px] font-semibold tracking-tightish">Buy at launch</span>
                <span className="text-[13px] text-t3 leading-snug">
                  Bundle a {quoteSymbol} first buy into the create transaction.
                </span>
              </div>
              <Toggle on={buyAtLaunch} onToggle={() => setBuyAtLaunch((v) => !v)} />
            </div>

            {buyAtLaunch && (
              <Field label={`Buy at launch · ${quoteSymbol}`}>
                <div className="flex items-center gap-3">
                  <input
                    value={firstBuy}
                    onChange={(e) => setFirstBuy(e.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                    className={FIELD}
                  />
                  <div className="flex gap-1.5 shrink-0">
                    {FIRST_BUY_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setFirstBuy(p)}
                        className="px-3 py-1.5 rounded-full bg-s1 border border-hair text-[13px] font-semibold tabular-nums text-t2 hover:text-white"
                      >
                        ${p === '1000' ? '1K' : p}
                      </button>
                    ))}
                  </div>
                </div>
              </Field>
            )}

            {error && (
              <p className="text-xs text-coral flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
              </p>
            )}

            {pendingRegister && (
              <div className="rounded-[14px] border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
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
                    className="h-9 px-4 rounded-full bg-amber-500 text-black text-[13px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    {registering ? 'Retrying…' : 'Retry save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/token/${pendingRegister.token}`)}
                    className="h-9 px-4 rounded-full border border-hair text-[13px] font-medium text-t2 hover:text-white"
                  >
                    Skip, view token
                  </button>
                </div>
              </div>
            )}
          </>
        )}
    </>
  )

  const cta = (
    <button
      type="button"
      disabled={
        isConnected && !wrongChain
          ? !canSubmit
          : connecting || switching
      }
      onClick={onCta}
      className={`w-full h-12 rounded-full text-[15px] font-semibold tracking-tightish disabled:opacity-40 flex items-center justify-center gap-2 ${
        isConnected && wrongChain ? 'bg-amber-500 text-black' : 'bg-lime text-white hover:bg-lime-2'
      }`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : step === 'done' ? <CheckCircle className="w-4 h-4" /> : null}
      {launchCta}
    </button>
  )

  if (compact) {
    return (
      <div>
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Launch this</h1>
        <p className="mt-2.5 mb-5 text-[15px] text-t2 leading-relaxed">
          Instant TOKEN/USDC. 1B supply, LP locked. Confirm to mint. We do not send the tx for you.
        </p>
        <div className="space-y-5">{fields}</div>
        {launchesLive ? <div className="mt-6">{cta}</div> : null}
      </div>
    )
  }

  return (
    <div>
      <p className="m-0 text-xs font-medium tracking-[0.16em] text-t3 uppercase">Launch</p>
      <h1 className="mt-2 mb-0 text-3xl font-semibold tracking-tight">One transaction. Full float.</h1>
      <p className="mt-2 max-w-xl text-sm text-t2 text-pretty">
        1B supply, Uniswap V3, LP locked, pair {quoteSymbol}. ${feeUsd.toFixed(2)} creation fee.
        Launch-token LP fees auto-burn.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">{fields}</div>
        {launchesLive ? (
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <TokenCard token={previewToken} preview />
            <div className="rounded-2xl bg-s1 p-5 text-sm border border-hair">
              <FeeRow k="Creation fee" v={`$${feeUsd.toFixed(2)}`} />
              <FeeRow k="First buy" v={`$${buyUsd.toFixed(2)}`} />
              <FeeRow k="You pay" v={`$${payUsd.toFixed(2)}`} />
              <FeeRow
                k="Wallet"
                v={
                  !isConnected
                    ? 'Not connected'
                    : walletUsd == null
                      ? usdcQ.isPending
                        ? '…'
                        : '—'
                      : fmtUsd(walletUsd)
                }
              />
              <div className="mt-4">{cta}</div>
              <p className="mt-3 mb-0 text-xs text-t3 leading-relaxed">
                Gas on Arc · launch-token LP fees auto-burn · pair {quoteSymbol}
              </p>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-xs text-t3">{label}</div>
      {children}
    </label>
  )
}

function FeeRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-t2">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  )
}

function TypeCard({
  active,
  onClick,
  title,
  body,
  disabled,
  soon,
}: {
  active?: boolean
  onClick?: () => void
  title: string
  body: string
  disabled?: boolean
  soon?: boolean
}) {
  const cls = `relative rounded-2xl bg-s1 p-4 text-left border transition-colors duration-150 ${
    disabled
      ? 'border-hair opacity-60 cursor-not-allowed'
      : active
        ? 'border-lime-line'
        : 'border-hair hover:border-lime-line'
  }`
  const inner = (
    <>
      {soon ? (
        <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-t3 bg-white/5">
          Soon
        </span>
      ) : null}
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 mb-0 text-xs leading-relaxed text-t2">{body}</p>
    </>
  )
  if (disabled || !onClick) return <div className={cls}>{inner}</div>
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  )
}

const FIELD =
  'w-full h-11 rounded-2xl bg-s1 px-4 text-sm text-white outline-none border border-hair focus:border-lime-line placeholder:text-white/30'

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
