'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { isAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from 'viem'
import { ChevronLeft, Rocket } from 'lucide-react'
import { CREATE_FEE_USDC } from '@/lib/port/types'
import { formatUsdc } from '@/lib/port/format'
import { ImageUpload } from '@/components/port/ImageUpload'
import { OfficialBadge } from '@/components/port/OfficialBadge'
import { BrandMark } from '@/components/BrandMark'
import { PORT_FACTORY_ABI } from '@/lib/port/abi'
import { arcPortEnabled, arcPortFactory } from '@/lib/port/contracts'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { uploadImageToCloudinary } from '@/lib/cloudinary'

const inputClass =
  'h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] tracking-tightish outline-none transition-[border-color] duration-150 focus:border-lime-line placeholder:text-white/25'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-medium text-white">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[13px] leading-snug text-t3">{hint}</span> : null}
    </label>
  )
}

function localDatetimeValue(d = new Date()) {
  const x = new Date(d)
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset())
  return x.toISOString().slice(0, 16)
}

export default function PortCreatePage() {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const live = arcPortEnabled()
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  const [step, setStep] = useState<1 | 2>(1)
  const [image, setImage] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [creatorWallet, setCreatorWallet] = useState('')
  const [maxSupply, setMaxSupply] = useState('100')
  const [maxPerWallet, setMaxPerWallet] = useState('5')
  const [mintPrice, setMintPrice] = useState('10')
  const [publicStart, setPublicStart] = useState(localDatetimeValue)
  const [allowlist, setAllowlist] = useState(false)
  const [royalty, setRoyalty] = useState(5)
  const [originInput, setOriginInput] = useState('')
  const [originInfo, setOriginInfo] = useState<{
    token: string
    name: string
    symbol: string
    creator: string
    linkedCollection: string | null
  } | null>(null)
  const [originStatus, setOriginStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [feeWei, setFeeWei] = useState<bigint | null>(null)

  useEffect(() => {
    if (!live || !address || !publicClient) {
      setFeeWei(null)
      return
    }
    let cancelled = false
    publicClient
      .readContract({
        address: arcPortFactory(),
        abi: PORT_FACTORY_ABI,
        functionName: 'creationFeeDue',
        args: [address],
      })
      .then((v) => {
        if (!cancelled) setFeeWei(v)
      })
      .catch(() => {
        if (!cancelled) setFeeWei(null)
      })
    return () => {
      cancelled = true
    }
  }, [live, address, publicClient])

  useEffect(() => {
    const raw = originInput.trim()
    if (!raw) {
      setOriginInfo(null)
      setOriginStatus('')
      return
    }
    if (!isAddress(raw)) {
      setOriginInfo(null)
      setOriginStatus('')
      return
    }
    let cancelled = false
    setOriginStatus('Checking…')
    const t = setTimeout(() => {
      fetch(`/api/port/origin-token?token=${raw}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return
          if (!d?.ok) {
            setOriginInfo(null)
            setOriginStatus('Not a live Instant or Reflection token on Arc.')
            return
          }
          setOriginInfo({
            token: d.token,
            name: d.name,
            symbol: d.symbol,
            creator: d.creator,
            linkedCollection: d.linkedCollection,
          })
          setName((n) => (n.trim() ? n : d.name || ''))
          setSymbol((s) => (s.trim() ? s : String(d.symbol || '').toUpperCase().slice(0, 8)))
          if (d.linkedCollection) {
            setOriginStatus(`$${d.symbol} already has a linked collection.`)
          } else {
            setOriginStatus(`$${d.symbol} · creator ${d.creator.slice(0, 6)}…${d.creator.slice(-4)}`)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setOriginInfo(null)
            setOriginStatus('Could not look up that token.')
          }
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [originInput])

  function originBlocked(): string | null {
    const raw = originInput.trim()
    if (!raw) return null
    if (!isAddress(raw) || !originInfo) return 'Token is not a live Instant or Reflection launch.'
    if (originInfo.linkedCollection) return `$${originInfo.symbol} already has a linked collection.`
    if (address && originInfo.creator.toLowerCase() !== address.toLowerCase()) {
      return `Only the creator of $${originInfo.symbol} can link this collection.`
    }
    return null
  }

  function goMintSettings() {
    setError('')
    if (!imageFile && !image) {
      setError('Add a collection image')
      return
    }
    if (name.trim().length < 2) {
      setError('Name needs at least 2 characters')
      return
    }
    if (symbol.trim().length < 2) {
      setError('Symbol needs at least 2 characters')
      return
    }
    const blocked = originBlocked()
    if (blocked) {
      setError(blocked)
      return
    }
    setStep(2)
  }

  async function publish() {
    setError('')
    if (!isConnected) {
      const c = connectors[0]
      if (c) connect({ connector: c })
      return
    }
    if (wrongChain) {
      switchChain({ chainId: ARC_CHAIN_ID })
      return
    }
    if (!live) {
      setError('Factory is not deployed yet. Publish will send createCollection once it is live.')
      return
    }
    const supply = Number(maxSupply)
    const per = Number(maxPerWallet)
    const price = Number(mintPrice)
    if (!supply || supply < 1) {
      setError('Max supply must be at least 1')
      return
    }
    if (!per || per < 1) {
      setError('Max per wallet must be at least 1')
      return
    }
    if (Number.isNaN(price) || price < 0) {
      setError('Set a mint price')
      return
    }
    if (creatorWallet.trim() && !isAddress(creatorWallet.trim())) {
      setError('Creator rewards wallet must be a valid 0x address (or leave blank)')
      return
    }
    const blocked = originBlocked()
    if (blocked) {
      setError(blocked)
      return
    }
    setBusy(true)
    try {
      let imageUrl = image
      if (imageFile) {
        imageUrl = await uploadImageToCloudinary(imageFile, 'port')
      }
      const start = publicStart
        ? Math.floor(new Date(publicStart).getTime() / 1000)
        : Math.floor(Date.now() / 1000)
      const payout =
        creatorWallet.trim() && isAddress(creatorWallet.trim())
          ? (creatorWallet.trim() as Address)
          : zeroAddress
      const due =
        feeWei ??
        (publicClient
          ? await publicClient.readContract({
              address: arcPortFactory(),
              abi: PORT_FACTORY_ABI,
              functionName: 'creationFeeDue',
              args: [address!],
            })
          : 0n)
      const hash = await writeContractAsync({
        address: arcPortFactory(),
        abi: PORT_FACTORY_ABI,
        functionName: 'createCollection',
        args: [
          {
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            unrevealedURI: imageUrl,
            baseURI: '',
            revealed: false,
            maxSupply: BigInt(Math.floor(supply)),
            maxPerWallet: BigInt(Math.floor(per)),
            price: parseUnits(String(price), 6),
            publicMintStart: BigInt(start),
            allowlistMintStart: 0n,
            allowlistMintEnd: 0n,
            allowlistRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
            royaltyBps: BigInt(royalty * 100),
            creatorRewardsWallet: payout,
            originToken: (originInfo?.token as Address) || zeroAddress,
          },
        ],
        value: due > 0n ? due : undefined,
        chainId: ARC_CHAIN_ID,
      })
      if (!publicClient) throw new Error('No Arc RPC client to confirm the transaction.')
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      const [created] = parseEventLogs({
        abi: PORT_FACTORY_ABI,
        eventName: 'CollectionCreated',
        logs: rcpt.logs,
      })
      const collection = created?.args?.collection as Address | undefined
      if (!collection) throw new Error('Collection created but the address was not in the receipt.')
      await fetch('/api/port/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: collection,
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          description: description.trim(),
          imageUrl,
          twitter: twitter.trim(),
          telegram: telegram.trim(),
          website: website.trim(),
          creator: address,
          originToken: originInfo?.token,
        }),
      }).catch(() => null)
      router.push(`/port/${collection}`)
    } catch (err: unknown) {
      const ax = err as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(err)
      setError(msg.length > 220 ? msg.slice(0, 220) + '…' : msg)
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (step === 1) goMintSettings()
    else void publish()
  }

  const primaryLabel =
    step === 1
      ? 'Continue'
      : !isConnected
        ? 'Connect'
        : switching
          ? 'Switch network…'
          : wrongChain
            ? 'Switch to Arc'
            : busy
              ? 'Publishing…'
              : 'Publish contract'

  return (
    <main className="min-h-screen pt-16 text-white">
      <div className="flex h-12 items-center gap-3 border-b border-hair2 px-4 sm:px-6">
        <Link
          href={step === 1 ? '/port' : '#'}
          onClick={(e) => {
            if (step === 2) {
              e.preventDefault()
              setError('')
              setStep(1)
            }
          }}
          className="grid h-9 w-9 place-items-center rounded-xl text-t2 hover:bg-s2 hover:text-white"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className={step === 1 ? 'font-semibold text-white' : 'text-t3'}>Create collection</span>
          <span className="text-t3">/</span>
          <span className={step === 1 ? 'font-semibold text-white' : 'text-t3'}>
            Deploy smart contract
          </span>
          {step === 2 ? (
            <>
              <span className="text-t3">/</span>
              <span className="font-semibold text-white">Mint</span>
            </>
          ) : null}
        </div>
      </div>

      <form onSubmit={onSubmit} className="pb-28">
        {step === 1 ? (
          <div className="mx-auto grid min-h-[calc(100vh-8.5rem)] max-w-[1280px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <div className="flex flex-col border-b border-hair p-5 pb-24 sm:p-8 lg:border-b-0 lg:border-r lg:pb-28">
              <ImageUpload
                variant="hero"
                value={image}
                onChange={(src, file) => {
                  setImage(src)
                  setImageFile(file ?? null)
                }}
              />
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-hair bg-s2 px-2.5 text-[11px] font-semibold tracking-wide text-t2">
                  <BrandMark className="h-3.5 w-3.5" />
                  ARC
                </span>
                <span className="inline-flex h-7 items-center rounded-full border border-hair bg-s2 px-2.5 text-[11px] font-semibold tracking-wide text-t2">
                  ERC-721
                </span>
              </div>
            </div>

            <div className="flex flex-col justify-center px-5 py-8 sm:px-10 lg:px-14">
              <div className="mb-6 grid h-11 w-11 place-items-center rounded-xl border border-hair bg-s2">
                <Rocket className="h-5 w-5 text-t2" strokeWidth={1.7} />
              </div>
              <h1 className="text-[28px] font-semibold tracking-display sm:text-[32px]">
                Start with your collection contract
              </h1>
              <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-t2">
                Every collection lives on its own ERC-721. We deploy one for you on Arc so
                collectors can mint in USDC.
              </p>

              <div className="mt-8 max-w-xl space-y-5">
                <Field
                  label="Name"
                  hint="Your contract name is the same as your collection name. You cannot update it later."
                >
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Add contract name"
                    maxLength={32}
                    className={inputClass}
                  />
                </Field>
                <Field label="Token symbol" hint="Cannot be changed after your contract is deployed.">
                  <input
                    value={symbol}
                    onChange={(e) =>
                      setSymbol(e.target.value.toUpperCase().replace(/\$/g, '').slice(0, 8))
                    }
                    placeholder="TICKER"
                    maxLength={8}
                    className={`${inputClass} max-w-[220px]`}
                  />
                </Field>
                <Field
                  label="Chain"
                  hint="Collections on ArcPort live on Arc. You cannot switch later."
                >
                  <div className="flex h-12 max-w-sm items-center gap-2.5 rounded-full border border-hair bg-s2 px-3.5">
                    <BrandMark className="h-5 w-5" />
                    <span className="text-[15px] font-semibold">Arc</span>
                  </div>
                </Field>
                <Field
                  label="Link a live token"
                  hint="Optional. Only the Instant/Reflection token creator can bind a collection. Stops copycats minting under someone else's ticker."
                >
                  <input
                    value={originInput}
                    onChange={(e) => setOriginInput(e.target.value.trim())}
                    placeholder="0x… token address"
                    className={inputClass}
                  />
                  {originStatus ? (
                    <span
                      className={`mt-1.5 flex items-center gap-1.5 text-[13px] ${
                        originInfo &&
                        !originInfo.linkedCollection &&
                        (!address || originInfo.creator.toLowerCase() === address.toLowerCase())
                          ? 'text-[#e2b340]'
                          : 'text-t3'
                      }`}
                    >
                      {originInfo &&
                      !originInfo.linkedCollection &&
                      (!address || originInfo.creator.toLowerCase() === address.toLowerCase()) ? (
                        <OfficialBadge symbol={originInfo.symbol} size="sm" />
                      ) : (
                        originStatus
                      )}
                    </span>
                  ) : null}
                </Field>
              </div>
              {error ? <p className="mt-6 max-w-xl text-[13px] text-coral">{error}</p> : null}
            </div>
          </div>
        ) : (
          <div className="mx-auto grid max-w-[1280px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <div className="hidden border-r border-hair p-8 lg:block">
              <div className="overflow-hidden rounded-[20px] border border-hair bg-s1">
                <div className="aspect-square bg-s2">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="p-4">
                  <div className="truncate text-[17px] font-semibold">{name.trim() || 'Untitled'}</div>
                  <div className="mt-1 text-[13px] text-t3">
                    {symbol.trim() || 'TICKER'} · Arc · ERC-721
                  </div>
                </div>
              </div>
            </div>
            <div className="px-5 py-8 sm:px-10 lg:px-14">
              <h1 className="text-[28px] font-semibold tracking-display sm:text-[32px]">Mint</h1>
              <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-t2">
                The contract needs a supply and a USDC price at deploy. Set them here, then
                publish.
              </p>
              <div className="mt-8 max-w-xl space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Max supply">
                    <input
                      inputMode="numeric"
                      value={maxSupply}
                      onChange={(e) => setMaxSupply(e.target.value.replace(/[^\d]/g, ''))}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Max per wallet">
                    <input
                      inputMode="numeric"
                      value={maxPerWallet}
                      onChange={(e) => setMaxPerWallet(e.target.value.replace(/[^\d]/g, ''))}
                      className={inputClass}
                    />
                  </Field>
                </div>
                <Field label="Mint price">
                  <div className="relative">
                    <input
                      inputMode="decimal"
                      value={mintPrice}
                      onChange={(e) => setMintPrice(e.target.value.replace(/[^\d.]/g, ''))}
                      className={`${inputClass} pr-16`}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-[13px] text-t3">
                      USDC
                    </span>
                  </div>
                </Field>
                <Field label="Public start">
                  <input
                    type="datetime-local"
                    value={publicStart}
                    onChange={(e) => setPublicStart(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label={`Royalty · ${royalty}%`}>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={royalty}
                    onChange={(e) => setRoyalty(Number(e.target.value))}
                    className="mt-2 w-full accent-[#2f84db]"
                  />
                  <div className="mt-1 flex justify-between text-[13px] text-t3">
                    <span>0%</span>
                    <span>10%</span>
                  </div>
                </Field>
                <Field label="Creator rewards wallet" hint="Leave blank to use your connected wallet.">
                  <input
                    value={creatorWallet}
                    onChange={(e) => setCreatorWallet(e.target.value)}
                    placeholder="0x…"
                    className={inputClass}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional"
                    maxLength={280}
                    className={`${inputClass} h-auto min-h-[96px] resize-none py-3`}
                  />
                </Field>
                <Field label="X / Twitter">
                  <input
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    placeholder="@handle or URL"
                    className={inputClass}
                  />
                </Field>
                <Field label="Telegram">
                  <input
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    placeholder="t.me/…"
                    className={inputClass}
                  />
                </Field>
                <Field label="Website">
                  <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://…"
                    className={inputClass}
                  />
                </Field>
                <label className="flex h-12 items-center justify-between rounded-xl border border-hair bg-s2 px-3.5">
                  <span className="text-[15px]">Allowlist</span>
                  <input
                    type="checkbox"
                    checked={allowlist}
                    onChange={(e) => setAllowlist(e.target.checked)}
                    className="h-5 w-5 accent-[#2f84db]"
                  />
                </label>
                <div className="rounded-[20px] border border-hair bg-s1 p-4">
                  <div className="flex items-center justify-between text-[15px]">
                    <span className="text-t3">Creation fee</span>
                    <span className="font-semibold tabular-nums">
                      {feeWei === 0n ? 'Free' : `${formatUsdc(CREATE_FEE_USDC)} USDC`}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] text-t3">
                    0.1 native USDC. Factory owner wallets skip this fee.
                  </p>
                </div>
              </div>
              {error ? <p className="mt-6 max-w-xl text-[13px] text-coral">{error}</p> : null}
            </div>
          </div>
        )}

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hair bg-[rgba(10,15,24,0.92)] backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1280px] items-center justify-end gap-3 px-4 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] sm:px-8">
            <Link
              href="/port"
              className="inline-flex h-11 items-center rounded-full border border-hair px-5 text-[14px] font-semibold text-t2 hover:text-white"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isPending || switching || busy}
              className="inline-flex h-11 min-w-[160px] items-center justify-center rounded-full bg-lime px-6 text-[14px] font-semibold text-white hover:bg-lime-2 disabled:opacity-50"
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </form>
    </main>
  )
}
