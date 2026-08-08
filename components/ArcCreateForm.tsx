'use client'

/**
 * Launch a token on Arc — InstantErc20QuoteFactory.createTokenMemeInstantQuote.
 * Full supply mints single-sided into a fresh TOKEN/USDC Uniswap V3 pool (1% tier) at creation;
 * the LP NFT locks in MonLock for a year. This is the only Arc launch path today — the bonding
 * curve was withdrawn upstream (see lib/contracts-arc.ts `arcCurveEnabled()`).
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain, useWriteContract, usePublicClient } from 'wagmi'
import { erc20Abi, parseEventLogs } from 'viem'
import { Loader2, ImagePlus, AlertCircle, CheckCircle } from 'lucide-react'
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

type Step = 'idle' | 'uploading' | 'approving' | 'creating' | 'confirming' | 'registering' | 'done'

export function ArcCreateForm() {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string>('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [firstBuy, setFirstBuy] = useState('')

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const configured = arcInstantEnabled()
  const busy = step !== 'idle' && step !== 'done'

  const onPickImage = (f: File | null) => {
    setImageFile(f)
    setImagePreview(f ? URL.createObjectURL(f) : '')
  }

  const onSubmit = async () => {
    if (!address) return
    setError(null)
    try {
      let imageUrl = ''
      if (imageFile) {
        setStep('uploading')
        imageUrl = await uploadImageToCloudinary(imageFile, 'arcfun')
      }

      const feeWei = arcCreationFeeWeiFor(address)
      const firstBuyUsdc6 = firstBuy && Number(firstBuy) > 0 ? parseArcUsdc(firstBuy) : 0n

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
      if (!token) throw new Error('Token created, but could not read its address from the transaction. Check ArcScan.')

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
    isConnected && !wrongChain && name.trim().length > 0 && symbol.trim().length > 0 && !busy && configured

  if (!configured) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc Instant factory isn't configured — set NEXT_PUBLIC_ARC_INSTANT_FACTORY / NEXT_PUBLIC_ARC_INSTANT_LOCKER.
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div className="flex items-center gap-4">
        <label className="shrink-0 w-20 h-20 rounded-2xl border border-dashed border-white/15 bg-white/5 flex items-center justify-center cursor-pointer overflow-hidden hover:border-sky-500/40">
          {imagePreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imagePreview} alt="" className="w-full h-full object-cover" />
          ) : (
            <ImagePlus className="w-6 h-6 text-gray-500" />
          )}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
          />
        </label>
        <div className="flex-1 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name"
            maxLength={64}
            className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-sky-500/40"
          />
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="TICKER"
            maxLength={12}
            className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm font-mono outline-none focus:border-sky-500/40"
          />
        </div>
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        maxLength={500}
        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-sky-500/40 resize-none"
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          value={twitter}
          onChange={(e) => setTwitter(e.target.value)}
          placeholder="X / Twitter (optional)"
          className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-sky-500/40"
        />
        <input
          value={telegram}
          onChange={(e) => setTelegram(e.target.value)}
          placeholder="Telegram (optional)"
          className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-sky-500/40"
        />
        <input
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="Website (optional)"
          className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-sky-500/40"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-gray-500">First buy — USDC (optional)</label>
        <input
          value={firstBuy}
          onChange={(e) => setFirstBuy(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm font-mono outline-none focus:border-sky-500/40"
        />
        <p className="text-[11px] text-gray-600">
          Buys your own launch immediately after the pool is created. Leave blank to launch with no first buy.
        </p>
      </div>

      {error && (
        <p className="text-xs text-rose-400 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
        </p>
      )}

      {!isConnected ? (
        <button
          type="button"
          disabled={connecting}
          onClick={() => connect({ connector: connectors[0] })}
          className="w-full py-3 rounded-xl bg-white/10 hover:bg-white/15 text-white text-sm font-semibold disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
      ) : wrongChain ? (
        <button
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
          className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold disabled:opacity-50"
        >
          {switching ? 'Switching…' : 'Switch to Arc'}
        </button>
      ) : (
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void onSubmit()}
          className="w-full py-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-black text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> {stepLabel(step)}
            </>
          ) : step === 'done' ? (
            <>
              <CheckCircle className="w-4 h-4" /> Launched
            </>
          ) : (
            'Launch on Arc'
          )}
        </button>
      )}

      <p className="text-[11px] text-gray-600 text-center">
        Full supply mints straight onto Uniswap V3 (USDC pair, 1% fee) and locks for a year. No presale, no team allocation held back by this app.
      </p>
    </div>
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
