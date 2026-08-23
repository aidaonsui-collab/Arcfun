'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { isAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from 'viem'
import { CREATE_FEE_USDC } from '@/lib/port/types'
import { formatUsdc, shortAddr } from '@/lib/port/format'
import { ImageUpload } from '@/components/port/ImageUpload'
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
      <span className="mb-2 block text-[13px] font-medium text-t2">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[13px] text-t3">{hint}</span> : null}
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
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
      setError('Port factory is not deployed yet. Marketplace UI is live; create waits on that address.')
      return
    }
    if (!imageFile && !image) {
      setError('Add an image')
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
    setBusy(true)
    try {
      let imageUrl = image
      if (imageFile) {
        imageUrl = await uploadImageToCloudinary(imageFile, 'port')
      }
      const start = publicStart ? Math.floor(new Date(publicStart).getTime() / 1000) : Math.floor(Date.now() / 1000)
      const payout = creatorWallet.trim() && isAddress(creatorWallet.trim())
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
            allowlistRoot:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            royaltyBps: BigInt(royalty * 100),
            creatorRewardsWallet: payout,
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

  const priceNum = Number(mintPrice) || 0
  const rewardsPreview = creatorWallet.trim()
    ? shortAddr(creatorWallet.trim())
    : address
      ? 'Your wallet'
      : 'Your wallet'

  return (
    <main className="min-h-screen pt-16 pb-24 text-white">
      <div className="mx-auto w-full max-w-desk px-4 sm:px-10">
        <div className="grid gap-10 pb-10 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <form onSubmit={onSubmit} className="rise-in max-w-xl">
            <h1 className="text-[32px] font-semibold tracking-display sm:text-[40px]">
              Create collection
            </h1>
            <p className="mt-2 text-[15px] text-t3">
              Launchpad for creators. Collectors mint in USDC on ArcPort.
            </p>

            <div className="mt-8 space-y-5">
              <ImageUpload
                value={image}
                onChange={(src, file) => {
                  setImage(src)
                  setImageFile(file ?? null)
                }}
                label="Collection image"
              />
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Untitled"
                  maxLength={32}
                  className={inputClass}
                />
              </Field>
              <Field label="Symbol">
                <input
                  value={symbol}
                  onChange={(e) =>
                    setSymbol(e.target.value.toUpperCase().replace(/\$/g, '').slice(0, 8))
                  }
                  placeholder="TICKER"
                  maxLength={8}
                  className={inputClass}
                />
              </Field>
              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Say what it is in one line."
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
              <Field label="Creator rewards wallet" hint="Leave blank to use your connected wallet">
                <input
                  value={creatorWallet}
                  onChange={(e) => setCreatorWallet(e.target.value)}
                  placeholder="0x…"
                  className={inputClass}
                />
              </Field>
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
              <label className="flex h-12 items-center justify-between rounded-xl border border-hair bg-s2 px-3.5">
                <span className="text-[15px]">Allowlist</span>
                <input
                  type="checkbox"
                  checked={allowlist}
                  onChange={(e) => setAllowlist(e.target.checked)}
                  className="h-5 w-5 accent-[#2f84db]"
                />
              </label>
              <Field label={`Royalty · ${royalty}%`}>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={royalty}
                  onChange={(e) => setRoyalty(Number(e.target.value))}
                  className="mt-1 w-full accent-[#2f84db]"
                />
                <div className="mt-1 flex justify-between text-[13px] text-t3">
                  <span>0%</span>
                  <span>10%</span>
                </div>
              </Field>
            </div>

            <div className="mt-8 rounded-[24px] border border-hair bg-s1 p-4">
              <div className="flex items-center justify-between text-[15px]">
                <span className="text-t3">Creation fee</span>
                <span className="font-semibold tabular-nums">
                  {feeWei === 0n ? 'Free' : `${formatUsdc(CREATE_FEE_USDC)} USDC`}
                </span>
              </div>
              <p className="mt-1 text-[13px] text-t3">
                {live
                  ? '0.1 native USDC. Factory owner skips this fee.'
                  : 'Same Instant create fee. Factory owner skips it once deployed.'}
              </p>
            </div>

            {error ? <p className="mt-4 text-[13px] text-coral">{error}</p> : null}

            <button
              type="submit"
              disabled={isPending || switching || busy}
              className="mt-6 h-14 w-full rounded-xl bg-lime text-[16px] font-bold text-white hover:bg-lime-2 disabled:opacity-50"
            >
              {!isConnected
                ? 'Connect to create'
                : switching
                  ? 'Switch network…'
                  : wrongChain
                    ? 'Switch to Arc'
                    : busy
                      ? 'Creating…'
                      : live
                        ? 'Create collection'
                        : 'Factory not deployed'}
            </button>
          </form>

          <aside className="rise-in-2 hidden lg:sticky lg:top-24 lg:block">
            <div className="text-[13px] font-medium text-t3">Live preview</div>
            <div className="mt-3 overflow-hidden rounded-[24px] border border-hair bg-s1">
              <div className="aspect-square bg-s2">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full place-items-center text-[13px] text-t3">Image</div>
                )}
              </div>
              <div className="p-4">
                <div className="truncate text-[17px] font-semibold tracking-tightish">
                  {name.trim() || 'Untitled'}
                </div>
                <div className="mt-1 text-[13px] text-t3">
                  {symbol.trim() || 'TICKER'} · {formatUsdc(priceNum)} USDC
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-[13px]">
                  <div className="rounded-xl bg-s2 px-3 py-2">
                    <div className="text-t3">Supply</div>
                    <div className="font-medium tabular-nums">{maxSupply || '—'}</div>
                  </div>
                  <div className="rounded-xl bg-s2 px-3 py-2">
                    <div className="text-t3">Royalty</div>
                    <div className="font-medium tabular-nums">{royalty}%</div>
                  </div>
                  <div className="rounded-xl bg-s2 px-3 py-2">
                    <div className="text-t3">Rewards to</div>
                    <div className="truncate font-medium">{rewardsPreview}</div>
                  </div>
                  <div className="rounded-xl bg-s2 px-3 py-2">
                    <div className="text-t3">Allowlist</div>
                    <div className="font-medium">{allowlist ? 'On' : 'Off'}</div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
