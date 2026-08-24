'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { erc20Abi, parseUnits, type Address, type Hex } from 'viem'
import {
  allowlistWindowLive,
  collectionStatus,
  mintCta,
  publicMintLive,
  CREATOR_SHARE,
  PLATFORM_FEE,
  MAX_MINT_PER_TX,
  type Collection,
} from '@/lib/port/types'
import { formatUsdc } from '@/lib/port/format'
import { Price } from './Price'
import { PortSheet } from './PortSheet'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'

export function MintSheet({
  collection,
  open,
  onClose,
}: {
  collection: Collection | null
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const status = collection ? collectionStatus(collection) : 'sold'
  const total = (collection?.mintPriceUsdc ?? 0) * qty
  const max = collection
    ? Math.max(
        1,
        Math.min(collection.maxPerWallet, collection.maxSupply - collection.minted, MAX_MINT_PER_TX),
      )
    : 1
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  async function confirm() {
    setError('')
    if (!collection) return
    if (!isConnected) {
      const c = connectors[0]
      if (c) connect({ connector: c })
      return
    }
    if (wrongChain) {
      switchChain({ chainId: ARC_CHAIN_ID })
      return
    }
    if (status !== 'live') return
    setBusy(true)
    try {
      const unit = parseUnits(String(collection.mintPriceUsdc), 6)
      const paid = unit * BigInt(qty)
      const pub = publicMintLive(collection)
      const alOpen = allowlistWindowLive(collection)
      let proof: Hex[] = []
      let onList = false
      if (alOpen && address) {
        const row = (await fetch(
          `/api/studio/allowlist?collection=${collection.address}&wallet=${address}`,
        ).then((r) => r.json())) as { onList?: boolean; proof?: Hex[] }
        onList = Boolean(row.onList)
        proof = row.proof || []
      }
      if (!pub && !onList) {
        throw new Error(alOpen ? 'This wallet is not on the allowlist.' : 'Mint is not live yet.')
      }
      if (paid > 0n) {
        await writeContractAsync({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [collection.address as Address, paid],
          chainId: ARC_CHAIN_ID,
        })
      }
      const hash = await writeContractAsync({
        address: collection.address as Address,
        abi: PORT_NFT_ABI,
        ...(onList && alOpen
          ? { functionName: 'mintAllowlist' as const, args: [BigInt(qty), proof] as const }
          : { functionName: 'mint' as const, args: [BigInt(qty)] as const }),
        chainId: ARC_CHAIN_ID,
      })
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      }
      await fetch('/api/studio/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: collection.address, txHash: hash }),
      }).catch(() => null)
      setQty(1)
      onClose()
      router.refresh()
    } catch (err: unknown) {
      const ax = err as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(err)
      setError(msg.length > 220 ? msg.slice(0, 220) + '…' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PortSheet
      open={open && !!collection}
      onClose={() => {
        setQty(1)
        setError('')
        onClose()
      }}
      title="Mint"
    >
      {collection ? (
        <div className="pb-2">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={collection.image} alt="" className="h-14 w-14 rounded-2xl object-cover" />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold">{collection.name}</div>
              <Price value={collection.mintPriceUsdc} />
            </div>
          </div>
          <div className="mt-6 flex items-center justify-between">
            <span className="text-[13px] text-t3">Quantity</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="h-11 w-11 rounded-xl border border-hair bg-s2 text-lg disabled:opacity-40"
                disabled={qty <= 1 || busy}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-8 text-center text-[17px] font-semibold tabular-nums">{qty}</span>
              <button
                type="button"
                className="h-11 w-11 rounded-xl border border-hair bg-s2 text-lg disabled:opacity-40"
                disabled={qty >= max || busy}
                onClick={() => setQty((q) => Math.min(max, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between text-[15px]">
            <span className="text-t3">Total</span>
            <span className="font-semibold tabular-nums">{formatUsdc(total)} USDC</span>
          </div>
          <p className="mt-3 text-[13px] text-t3">
            {Math.round(CREATOR_SHARE * 100)}% creator · {Math.round(PLATFORM_FEE * 100)}% platform
          </p>
          {collection.allowlist ? (
            <p className="mt-2 text-[13px] text-lime-t">Allowlist mint</p>
          ) : null}
          {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
          <button
            type="button"
            disabled={busy || isPending || switching || status !== 'live'}
            onClick={() => void confirm()}
            className="mt-6 h-14 w-full rounded-xl bg-lime text-[16px] font-bold text-white hover:bg-lime-2 disabled:opacity-50"
          >
            {!isConnected
              ? 'Connect to mint'
              : switching
                ? 'Switch network…'
                : wrongChain
                  ? 'Switch to Arc'
                  : busy
                    ? 'Confirming…'
                    : status === 'sold'
                      ? 'Sold out'
                      : status === 'soon'
                        ? mintCta(collection)
                        : 'Confirm mint'}
          </button>
        </div>
      ) : null}
    </PortSheet>
  )
}
