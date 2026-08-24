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
import { parseUnits, type Address } from 'viem'
import { PortSheet } from './PortSheet'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  STUDIO_FEE_BPS,
  buildListing,
  seaportDomain,
  studioTreasury,
} from '@/lib/port/seaport'
import { reviveOrder, type Listing } from '@/lib/port/listings'
import type { Collection, NftItem } from '@/lib/port/types'

const DURATION_SEC = 60 * 60 * 24 * 30 // 30 days

/**
 * Seller-side listing. Nothing here costs the seller anything beyond a one-time operator
 * approval: the order itself is an off-chain signature, so the buyer pays all the gas.
 */
export function ListSheet({
  collection,
  item,
  listing = null,
  open,
  onClose,
}: {
  collection: Collection
  item: NftItem
  listing?: Listing | null
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
  const valid = Number.isFinite(priceNum) && priceNum > 0

  // Preview of the split, computed the same way the order will be built.
  const priceAtomic = valid ? parseUnits(price, 6) : 0n
  const feePreview = (priceAtomic * BigInt(STUDIO_FEE_BPS)) / 10_000n
  const royaltyPreview = (priceAtomic * BigInt(Math.round(collection.royalty * 100))) / 10_000n
  const sellerPreview = priceAtomic - feePreview - royaltyPreview

  async function cancelOnChain() {
    if (!listing || !address || !publicClient) return
    setStep('Cancel listing…')
    const h = await writeContractAsync({
      address: SEAPORT_ADDRESS,
      abi: SEAPORT_ABI,
      functionName: 'cancel',
      args: [[reviveOrder(listing.order)]],
      chainId: ARC_CHAIN_ID,
    })
    await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
    await fetch('/api/studio/orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderHash: listing.orderHash, action: 'cancel', txHash: h }),
    })
  }

  async function cancelOnly() {
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
    if (!listing || !address || !publicClient) return
    setBusy(true)
    try {
      await cancelOnChain()
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
      if (listing) await cancelOnChain()
      const nft = collection.address as Address
      const tokenId = BigInt(item.id)

      // 1. Seaport must be an approved operator or the fill will revert on transfer.
      setStep('Checking approval…')
      const approved = (await publicClient.readContract({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'isApprovedForAll',
        args: [address, SEAPORT_ADDRESS],
      })) as boolean
      if (!approved) {
        setStep('Approve Seaport (one time)…')
        const h = await writeContractAsync({
          address: nft,
          abi: PORT_NFT_ABI,
          functionName: 'setApprovalForAll',
          args: [SEAPORT_ADDRESS, true],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }

      // 2. Royalty comes from the collection itself (EIP-2981), never from a hardcoded number —
      //    the creator can be a different address than the collection owner.
      setStep('Reading royalty…')
      const [royaltyReceiver, royaltyAmount] = (await publicClient.readContract({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'royaltyInfo',
        args: [tokenId, priceAtomic],
      })) as [Address, bigint]

      // 3. Counter must be the offerer's current one or the signature is void from birth.
      const counter = (await publicClient.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [address],
      })) as bigint

      const now = BigInt(Math.floor(Date.now() / 1000))
      const order = buildListing({
        collection: nft,
        tokenId,
        priceAtomic,
        seller: address,
        royaltyReceiver,
        royaltyAmount,
        platformTreasury: studioTreasury(),
        counter,
        startTime: now - 60n, // small backdate absorbs clock skew between wallet and node
        endTime: now + BigInt(DURATION_SEC),
        salt: BigInt(Math.floor(Math.random() * 1e15)),
      })

      // 4. Free signature — no gas, nothing on-chain until a buyer fills it.
      setStep('Sign listing…')
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
        body: JSON.stringify(
          { order, signature },
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      })
      const j = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !j.ok) throw new Error(j.error || 'could not publish listing')

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
    <PortSheet open={open} onClose={() => { setError(''); onClose() }} title="List for sale">
      <div className="pb-2">
        <label className="text-[13px] text-t3">Price in USDC</label>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="0.00"
          className="mt-2 h-14 w-full rounded-xl border border-hair bg-s2 px-4 text-base outline-none placeholder:text-white/25"
        />

        {valid ? (
          <div className="mt-4 rounded-xl border border-hair bg-s1 px-4 py-3 text-[14px]">
            <Row label="You receive" value={`${fmt(sellerPreview)} USDC`} strong />
            <Row label={`Creator royalty (${collection.royalty}%)`} value={`${fmt(royaltyPreview)} USDC`} />
            <Row label={`Studio fee (${STUDIO_FEE_BPS / 100}%)`} value={`${fmt(feePreview)} USDC`} />
          </div>
        ) : null}

        <p className="mt-3 text-[13px] text-t3">
          Listing is free — you sign, the buyer pays gas. Expires in 30 days.
          {listing ? ' Updating cancels the current listing first (one on-chain tx).' : ''}
        </p>

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
                : listing
                  ? 'Update listing'
                  : 'List for sale'}
        </button>
        {listing && isConnected && !wrongChain ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancelOnly()}
            className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl border border-hair text-[14px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
          >
            Cancel listing
          </button>
        ) : null}
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
