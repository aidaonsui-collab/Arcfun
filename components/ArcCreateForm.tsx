'use client'

/**
 * Launch a token on Arc — InstantErc20QuoteFactory.createTokenMemeInstantQuote.
 * UI matches redesign: Instant vs Reflection type cards, live preview, ship sheet.
 * Reflection is UI-only until contracts land (CTA disabled when selected).
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain, useWriteContract, usePublicClient } from 'wagmi'
import { erc20Abi, parseEventLogs } from 'viem'
import { Loader2, AlertCircle, CheckCircle, ImagePlus } from 'lucide-react'
import {
  ARC,
  ARC_CHAIN_ID,
  ARC_INSTANT_CREATE_GAS,
  arcInstantEnabled,
  arcCreationFeeWeiFor,
} from '@/lib/contracts-arc'
import {
  buildCreateTokenMemeInstantArc,
  parseArcUsdc,
  INSTANT_QUOTE_FACTORY_ABI,
} from '@/lib/arc-instant-launchpad'
import { uploadImageToCloudinary } from '@/lib/cloudinary'
import { tileGradient } from '@/lib/ui-format'

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
    title: 'Instant Launch',
    tagline: 'Tradable from block one',
    points: [
      'Full supply onto Uniswap V3 at creation',
      'No graduation, no waiting room',
      'LP NFT locked 12 months',
    ],
  },
  {
    key: 'reflection',
    icon: '◈',
    title: 'Reflection token',
    tagline: 'Every trade pays your holders',
    points: [
      'A slice of each trade redistributes to holders',
      'Rewards accrue in USDC, claimable any time',
      'Same instant Uniswap V3 pool underneath',
    ],
  },
]

const FIRST_BUY_PRESETS = ['100', '250', '1000']

export function ArcCreateForm() {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })

  const [launchType, setLaunchType] = useState<LaunchType>('instant')
  const [reflect, setReflect] = useState(2)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string>('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [creatorFee, setCreatorFee] = useState(true)
  const [buyAtLaunch, setBuyAtLaunch] = useState(false)
  const [firstBuy, setFirstBuy] = useState('250')

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const configured = arcInstantEnabled()
  const busy = step !== 'idle' && step !== 'done'
  const isReflection = launchType === 'reflection'

  const seed = symbol || name || 'new'
  const { tile, mono } = useMemo(() => tileGradient(seed), [seed])
  const previewInitial = (symbol || name || '?').charAt(0).toUpperCase()

  const onPickImage = (f: File | null) => {
    setImageFile(f)
    setImagePreview(f ? URL.createObjectURL(f) : '')
  }

  const onSubmit = async () => {
    if (!address) return
    if (isReflection) {
      setError('Reflection tokens aren’t live on Arc yet — pick Instant Launch to ship today.')
      return
    }
    setError(null)
    try {
      let imageUrl = ''
      if (imageFile) {
        setStep('uploading')
        imageUrl = await uploadImageToCloudinary(imageFile, 'arcfun')
      }

      const feeWei = arcCreationFeeWeiFor(address)
      const firstBuyUsdc6 =
        buyAtLaunch && firstBuy && Number(firstBuy) > 0 ? parseArcUsdc(firstBuy) : 0n

      if (firstBuyUsdc6 > 0n) {
        setStep('approving')
        await writeContractAsync({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ARC.INSTANT_FACTORY, firstBuyUsdc6],
          chainId: ARC_CHAIN_ID,
        })
      }

      setStep('creating')
      const call = buildCreateTokenMemeInstantArc(name.trim(), symbol.trim(), firstBuyUsdc6, feeWei)
      const hash = await writeContractAsync({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName as never,
        args: call.args as never,
        value: call.value,
        chainId: call.chainId,
        gas: ARC_INSTANT_CREATE_GAS,
      })
      setStep('confirming')

      if (!publicClient) throw new Error('No Arc RPC client available to confirm the transaction.')
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 })
      const [created] = parseEventLogs({
        abi: INSTANT_QUOTE_FACTORY_ABI,
        eventName: 'InstantQuoteTokenCreated',
        logs: rcpt.logs,
      })
      const token = created?.args?.token
      const pool = created?.args?.pool
      if (!token)
        throw new Error(
          'Token created, but could not read its address from the transaction. Check ArcScan.',
        )

      setStep('registering')
      await fetch('/api/arc/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim() || undefined,
          imageUrl: imageUrl || undefined,
          twitter: twitter.trim() || undefined,
          telegram: telegram.trim() || undefined,
          website: website.trim() || undefined,
          creator: address,
          pool: pool || undefined,
        }),
      }).catch(() => {})

      setStep('done')
      router.push(`/token/${token}`)
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(e)
      setError(msg.length > 200 ? msg.slice(0, 200) + '…' : msg)
      setStep('idle')
    }
  }

  const canSubmit =
    isConnected &&
    !wrongChain &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !busy &&
    configured &&
    !isReflection

  if (!configured) {
    return (
      <div className="rounded-[22px] border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc Instant factory isn&apos;t configured — set NEXT_PUBLIC_ARC_INSTANT_FACTORY /
        NEXT_PUBLIC_ARC_INSTANT_LOCKER.
      </div>
    )
  }

  const shipRows = [
    { k: 'Type', v: isReflection ? 'Reflection' : 'Instant' },
    { k: 'Supply', v: '1,000,000,000' },
    { k: 'Pair', v: 'USDC · 1% fee' },
    { k: 'Reflects', v: isReflection ? `${reflect}% to holders` : '—' },
    { k: 'LP lock', v: '12 months' },
    { k: 'Creator fee', v: creatorFee ? 'On (protocol default)' : 'Protocol default' },
  ]

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-7 items-start">
      {/* Main form card */}
      <div className="border border-hair rounded-[28px] bg-s1 p-6 sm:p-8">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Launch your token</h1>
        <p className="mt-2.5 mb-0 text-[15px] text-t2 leading-relaxed">
          Fixed supply of 1B. One transaction, straight onto Uniswap V3 in USDC. LP locks for a year
          the moment it mints.
        </p>

        {/* Launch type cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-[26px]">
          {LAUNCH_TYPES.map((lt) => {
            const on = launchType === lt.key
            return (
              <button
                key={lt.key}
                type="button"
                onClick={() => setLaunchType(lt.key)}
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
        </div>

        {isReflection && (
          <div className="mt-3 p-5 rounded-[22px] bg-s2 border border-lime-line">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-semibold tracking-tightish">Reflection rate</span>
                <span className="text-[13px] text-t3 leading-snug">
                  {reflect}% of every buy and sell is split across holders, pro rata. You keep the
                  rest of the LP fee.
                </span>
                <span className="text-[12px] text-coral mt-1">
                  Contracts not live yet — switch to Instant to launch today.
                </span>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {[1, 2, 3, 5].map((r) => {
                  const on = reflect === r
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReflect(r)}
                      className="px-3.5 py-2 rounded-xl text-[13px] font-semibold tabular-nums border transition-colors"
                      style={{
                        background: on ? 'var(--lime)' : '#000',
                        color: on ? '#fff' : 'rgba(255,255,255,0.58)',
                        borderColor: on ? 'var(--lime)' : 'var(--hair)',
                      }}
                    >
                      {r}%
                    </button>
                  )
                })}
              </div>
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

        {/* Creator fee toggle (display only — fee split is on-chain) */}
        <div className="flex items-center justify-between gap-4 p-[18px] rounded-[18px] bg-s2 border border-hair mt-3">
          <div className="flex flex-col gap-0.5 pr-5">
            <span className="text-[15px] font-semibold tracking-tightish">Creator fee</span>
            <span className="text-[13px] text-t3 leading-snug">
              Protocol routes creator share of LP fees in USDC. Split is set by the factory.
            </span>
          </div>
          <Toggle on={creatorFee} onToggle={() => setCreatorFee((v) => !v)} />
        </div>

        {/* Buy at launch */}
        <div className="flex items-center justify-between gap-4 p-[18px] rounded-[18px] bg-s2 border border-hair mt-3">
          <div className="flex flex-col gap-0.5 pr-5">
            <span className="text-[15px] font-semibold tracking-tightish">Buy at launch</span>
            <span className="text-[13px] text-t3 leading-snug">
              Bundle your own first buy into the launch transaction.
            </span>
          </div>
          <Toggle on={buyAtLaunch} onToggle={() => setBuyAtLaunch((v) => !v)} />
        </div>

        {buyAtLaunch && (
          <div className="px-[18px] py-3.5 rounded-[18px] bg-s2 border border-lime-line mt-3 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-t3">First buy — USDC</span>
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
              'Reflection coming soon'
            ) : (
              'Review launch'
            )}
          </button>
        )}

        <p className="mt-3.5 mb-0 text-xs text-t3 text-center leading-relaxed">
          Creation fee 1 USDC · gas on Arc · LP NFT locked 12 months in MonLock
        </p>
      </div>

      {/* Sticky preview */}
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
                {isReflection ? '◈ Reflect' : '⚡ Instant'}
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
