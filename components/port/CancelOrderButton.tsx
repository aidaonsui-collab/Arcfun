'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { SEAPORT_ABI, SEAPORT_ADDRESS } from '@/lib/port/seaport'
import { reviveOrder, type Listing } from '@/lib/port/listings'

export function CancelOrderButton({
  order,
  label = 'Cancel',
  onDone,
}: {
  order: Listing
  label?: string
  onDone?: () => void
}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  async function cancel() {
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
    if (!address || !publicClient) return
    setBusy(true)
    try {
      const h = await writeContractAsync({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'cancel',
        args: [[reviveOrder(order.order)]],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      await fetch('/api/studio/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderHash: order.orderHash, action: 'cancel', txHash: h }),
      })
      onDone?.()
      router.refresh()
    } catch (err: unknown) {
      const ax = err as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(err)
      setError(msg.length > 180 ? msg.slice(0, 180) + '…' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={busy}
        onClick={() => void cancel()}
        className="h-10 rounded-xl border border-hair px-4 text-[13px] font-semibold text-white hover:border-lime-line disabled:opacity-50"
      >
        {!isConnected ? 'Connect' : wrongChain ? 'Switch' : busy ? 'Cancelling…' : label}
      </button>
      {error ? <p className="mt-1 max-w-[10rem] text-[11px] text-coral">{error}</p> : null}
    </div>
  )
}
