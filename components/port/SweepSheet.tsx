'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { erc20Abi, type Hex } from 'viem'
import { PortSheet } from './PortSheet'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { CONDUIT_KEY, SEAPORT_ABI, SEAPORT_ADDRESS, toOrderParameters } from '@/lib/port/seaport'
import { isListing, reviveOrder, sortByPriceAsc, type Listing } from '@/lib/port/listings'
import { atomicToUsdc } from '@/lib/port/market'
import { formatUsdc } from '@/lib/port/format'

const MAX_SWEEP = 15

export function SweepSheet({
  listings,
  open,
  onClose,
}: {
  listings: Listing[]
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState('')

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const pool = useMemo(() => {
    const live = sortByPriceAsc(listings.filter(isListing))
    if (!address) return live
    return live.filter((l) => l.offerer.toLowerCase() !== address.toLowerCase())
  }, [listings, address])
  const max = Math.min(pool.length, MAX_SWEEP)
  const n = Math.min(Math.max(1, count), Math.max(1, max))
  const picked = pool.slice(0, n)
  const totalAtomic = picked.reduce((s, l) => s + BigInt(l.priceAtomic), 0n)
  const totalUsdc = atomicToUsdc(totalAtomic.toString())

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
    if (!address || !publicClient || picked.length === 0) return
    setBusy(true)
    try {
      setStep('Checking allowance…')
      const allowance = (await publicClient.readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, SEAPORT_ADDRESS],
      })) as bigint
      if (allowance < totalAtomic) {
        setStep('Approve USDC…')
        const h = await writeContractAsync({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [SEAPORT_ADDRESS, totalAtomic],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }

      let done = 0
      for (const row of picked) {
        setStep(`Buying ${done + 1} / ${picked.length}…`)
        const params = toOrderParameters(reviveOrder(row.order))
        const hash = await writeContractAsync({
          address: SEAPORT_ADDRESS,
          abi: SEAPORT_ABI,
          functionName: 'fulfillOrder',
          args: [{ parameters: params, signature: row.signature as Hex }, CONDUIT_KEY],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
        await fetch('/api/studio/orders', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderHash: row.orderHash,
            action: 'filled',
            txHash: hash,
            buyer: address,
            tokenId: row.tokenId,
          }),
        }).catch(() => null)
        done += 1
      }
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
      title="Sweep floor"
    >
      <div className="pb-2">
        {max === 0 ? (
          <p className="text-[14px] text-t2">No listings you can buy right now.</p>
        ) : (
          <>
            <p className="text-[14px] text-t2">
              Take the cheapest listed items. One USDC approval, then a fill per item.
            </p>
            <label className="mt-4 block text-[13px] text-t3">
              Items ({n} of {max})
            </label>
            <input
              type="range"
              min={1}
              max={max}
              value={n}
              onChange={(e) => setCount(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--lime)]"
            />
            <div className="mt-3 max-h-36 overflow-y-auto text-[13px] text-t3">
              {picked.map((l) => (
                <div key={l.orderHash} className="flex justify-between py-0.5">
                  <span>#{l.tokenId}</span>
                  <span className="tabular-nums">{formatUsdc(atomicToUsdc(l.priceAtomic))} USDC</span>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-hair bg-s1 px-4 py-3">
              <div className="text-[13px] text-t3">Total</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-display">
                {formatUsdc(totalUsdc)} USDC
              </div>
            </div>
          </>
        )}
        {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
        <button
          type="button"
          disabled={busy || (isConnected && !wrongChain && max === 0)}
          onClick={() => void confirm()}
          className="mt-5 inline-flex h-14 w-full items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {!isConnected
            ? 'Connect wallet'
            : wrongChain
              ? 'Switch to Arc'
              : busy
                ? step || 'Working…'
                : max === 0
                  ? 'Nothing to sweep'
                  : `Sweep ${n} for ${formatUsdc(totalUsdc)} USDC`}
        </button>
      </div>
    </PortSheet>
  )
}
