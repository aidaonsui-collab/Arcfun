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
import type { Collection, NftItem } from '@/lib/port/types'

const DURATION_SEC = 60 * 60 * 24 * 30

export function BatchListSheet({
  collection,
  items,
  open,
  onClose,
}: {
  collection: Collection
  items: NftItem[]
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
  const valid = Number.isFinite(priceNum) && priceNum > 0 && items.length > 0
  const priceAtomic = valid ? parseUnits(price, 6) : 0n

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

      const counter = (await publicClient.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [address],
      })) as bigint

      const [royaltyReceiver, royaltyAmount] = (await publicClient.readContract({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'royaltyInfo',
        args: [BigInt(items[0].id), priceAtomic],
      })) as [Address, bigint]

      const now = BigInt(Math.floor(Date.now() / 1000))
      let done = 0
      for (const item of items) {
        setStep(`Signing ${done + 1} / ${items.length}…`)
        const order = buildListing({
          collection: nft,
          tokenId: BigInt(item.id),
          priceAtomic,
          seller: address,
          royaltyReceiver,
          royaltyAmount,
          platformTreasury: studioTreasury(),
          counter,
          startTime: now - 60n,
          endTime: now + BigInt(DURATION_SEC),
          salt: BigInt(Math.floor(Math.random() * 1e15)) + BigInt(item.id),
        })
        const signature = await signTypedDataAsync({
          domain: seaportDomain(),
          types: SEAPORT_ORDER_TYPES,
          primaryType: 'OrderComponents',
          message: order as never,
        })
        const res = await fetch('/api/studio/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order, signature }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        })
        const j = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !j.ok) throw new Error(j.error || `could not list #${item.id}`)
        done += 1
      }
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

  return (
    <PortSheet open={open} onClose={() => { setError(''); onClose() }} title="List items">
      <div className="pb-2">
        <p className="text-[14px] text-t2">
          {items.length} item{items.length === 1 ? '' : 's'} at the same USDC price. One Seaport
          approval, then a signature per item.
        </p>
        <div className="mt-3 max-h-32 overflow-y-auto text-[13px] text-t3">
          {items.map((i) => (
            <div key={i.id}>#{i.id} {i.name}</div>
          ))}
        </div>
        <label className="mt-4 block text-[13px] text-t3">Price each in USDC</label>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="0.00"
          className="mt-2 h-14 w-full rounded-xl border border-hair bg-s2 px-4 text-base outline-none placeholder:text-white/25"
        />
        <p className="mt-3 text-[13px] text-t3">
          Studio fee {STUDIO_FEE_BPS / 100}% and {collection.royalty}% royalty come out of each sale.
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
                : `List ${items.length} item${items.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </PortSheet>
  )
}
