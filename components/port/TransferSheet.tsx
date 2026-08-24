'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { isAddress, zeroAddress, type Address } from 'viem'
import { PortSheet } from './PortSheet'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { SEAPORT_ABI, SEAPORT_ADDRESS } from '@/lib/port/seaport'
import { reviveOrder, type Listing } from '@/lib/port/listings'
import type { NftItem } from '@/lib/port/types'

export function TransferSheet({
  item,
  listing = null,
  open,
  onClose,
}: {
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
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState('')

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const dest = to.trim()
  const valid = isAddress(dest) && dest.toLowerCase() !== zeroAddress && dest.toLowerCase() !== address?.toLowerCase()

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
      const nft = item.collection as Address
      if (listing) {
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
        }).catch(() => null)
      }

      setStep('Sending…')
      const hash = await writeContractAsync({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'safeTransferFrom',
        args: [address, dest as Address, BigInt(item.id)],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      setTo('')
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
    <PortSheet
      open={open}
      onClose={() => {
        setError('')
        onClose()
      }}
      title={`Send ${item.name}`}
    >
      <div className="pb-2">
        <label className="block text-[13px] text-t3">Recipient wallet</label>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className="mt-2 h-14 w-full rounded-xl border border-hair bg-s2 px-4 font-mono text-[14px] outline-none placeholder:text-white/25"
        />
        {dest && !valid ? (
          <p className="mt-2 text-[13px] text-coral">
            {!isAddress(dest)
              ? 'Enter a valid address'
              : dest.toLowerCase() === address?.toLowerCase()
                ? 'That is this wallet'
                : 'Cannot send to the zero address'}
          </p>
        ) : null}
        {listing ? (
          <p className="mt-3 text-[13px] text-t3">
            This item is listed. Sending cancels the listing on Seaport first.
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-t3">On-chain transfer. The recipient pays nothing.</p>
        )}
        {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
        <button
          type="button"
          disabled={busy || (isConnected && !wrongChain && !valid)}
          onClick={() => void confirm()}
          className="mt-5 inline-flex h-14 w-full items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {!isConnected
            ? 'Connect wallet'
            : wrongChain
              ? 'Switch to Arc'
              : busy
                ? step || 'Working…'
                : 'Send'}
        </button>
      </div>
    </PortSheet>
  )
}
