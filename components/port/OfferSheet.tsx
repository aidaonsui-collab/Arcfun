'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  useAccount,
  useConnect,
  usePublicClient,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { erc20Abi, parseUnits, type Address } from 'viem'
import { PortSheet } from './PortSheet'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  SEAPORT_ADDRESS,
  SEAPORT_ABI,
  SEAPORT_ORDER_TYPES,
  STUDIO_FEE_BPS,
  buildOffer,
  seaportDomain,
  studioTreasury,
} from '@/lib/port/seaport'

const DURATION_SEC = 60 * 60 * 24 * 7

export function OfferSheet({
  collection,
  tokenId,
  open,
  onClose,
}: {
  collection: { address: string; name: string; royalty: number }
  tokenId?: number
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState('')

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const priceNum = Number(price)
  const priceAtomic = Number.isFinite(priceNum) && priceNum > 0 ? parseUnits(price, 6) : 0n
  const feePreview = (priceAtomic * BigInt(STUDIO_FEE_BPS)) / 10_000n
  const royaltyPreview = (priceAtomic * BigInt(Math.round(collection.royalty * 100))) / 10_000n
  const sellerPreview = priceAtomic - feePreview - royaltyPreview
  const valid = priceAtomic > 0n && sellerPreview > 0n
  const collectionWide = tokenId == null

  async function confirm() {
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
    if (!valid || !address || !publicClient) return
    setBusy(true)
    try {
      const nft = collection.address as Address
      setStep('Checking USDC…')
      const [balance, allowance] = (await Promise.all([
        publicClient.readContract({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, SEAPORT_ADDRESS],
        }),
      ])) as [bigint, bigint]
      if (balance < priceAtomic) throw new Error('Not enough USDC')
      if (allowance < priceAtomic) {
        setStep('Approve USDC…')
        const h = await writeContractAsync({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [SEAPORT_ADDRESS, priceAtomic],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }

      setStep('Reading royalty…')
      const idForRoyalty = BigInt(tokenId || 1)
      const [royaltyReceiver, royaltyAmount] = (await publicClient.readContract({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'royaltyInfo',
        args: [idForRoyalty, priceAtomic],
      })) as [Address, bigint]

      const counter = (await publicClient.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [address],
      })) as bigint

      const now = BigInt(Math.floor(Date.now() / 1000))
      const order = buildOffer({
        collection: nft,
        tokenId: collectionWide ? 0n : BigInt(tokenId!),
        priceAtomic,
        buyer: address,
        royaltyReceiver,
        royaltyAmount,
        platformTreasury: studioTreasury(),
        counter,
        startTime: now - 60n,
        endTime: now + BigInt(DURATION_SEC),
        salt: BigInt(Math.floor(Math.random() * 1e15)),
      })

      setStep('Sign offer…')
      const signature = await signTypedDataAsync({
        domain: seaportDomain(),
        types: SEAPORT_ORDER_TYPES,
        primaryType: 'OrderComponents',
        message: order as never,
      })

      setStep('Publishing…')
      const res = await fetch('/api/studio/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order, signature }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !j.ok) throw new Error(j.error || 'could not publish offer')
      setPrice('')
      onClose()
      router.refresh()
    } catch (err: unknown) {
      const ax = err as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(err)
      setError(msg.length > 220 ? msg.slice(0, 220) + '…' : msg)
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })

  return (
    <PortSheet
      open={open}
      onClose={() => { setError(''); onClose() }}
      title={collectionWide ? 'Collection offer' : 'Make offer'}
    >
      <div className="pb-2">
        <p className="text-[14px] text-t2">
          {collectionWide
            ? `Any minted ${collection.name} can fill this. Expires in 7 days.`
            : `Offer on ${collection.name} #${tokenId}. Expires in 7 days.`}
        </p>
        <label className="mt-4 block text-[13px] text-t3">Price in USDC</label>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="0.00"
          className="mt-2 h-14 w-full rounded-xl border border-hair bg-s2 px-4 text-base outline-none placeholder:text-white/25"
        />
        {priceAtomic > 0n && sellerPreview <= 0n ? (
          <p className="mt-3 text-[13px] text-coral">Price too low to cover royalty + studio fee.</p>
        ) : valid ? (
          <div className="mt-4 rounded-xl border border-hair bg-s1 px-4 py-3 text-[14px]">
            <Row label="Seller receives" value={`${fmt(sellerPreview)} USDC`} strong />
            <Row label={`Creator royalty (${collection.royalty}%)`} value={`${fmt(royaltyPreview)} USDC`} />
            <Row label={`Studio fee (${STUDIO_FEE_BPS / 100}%)`} value={`${fmt(feePreview)} USDC`} />
          </div>
        ) : null}
        <p className="mt-3 text-[13px] text-t3">You lock USDC approval. The seller pays gas to accept.</p>
        {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
        <button
          type="button"
          disabled={busy || (isConnected && !wrongChain && !valid)}
          onClick={confirm}
          className="mt-5 inline-flex h-14 w-full items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {!isConnected
            ? 'Connect wallet'
            : wrongChain
              ? 'Switch to Arc'
              : busy
                ? step || 'Working…'
                : collectionWide
                  ? 'Sign collection offer'
                  : 'Sign offer'}
        </button>
      </div>
    </PortSheet>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-t3">{label}</span>
      <span className={strong ? 'font-semibold text-white' : 'text-t2'}>{value}</span>
    </div>
  )
}
