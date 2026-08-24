'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { erc20Abi, type Address, type Hex } from 'viem'
import { PortSheet } from './PortSheet'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { CONDUIT_KEY, SEAPORT_ABI, SEAPORT_ADDRESS, toOrderParameters } from '@/lib/port/seaport'
import type { Listing } from '@/lib/port/listings'

/**
 * Buyer-side fill. The buyer pays gas and approves USDC to Seaport; Seaport atomically moves the
 * NFT from seller to buyer and splits the USDC across seller / creator / studio in one call, so
 * there is no state where one leg has settled and another hasn't.
 */
export function BuySheet({
  listing,
  open,
  onClose,
}: {
  listing: Listing | null
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState('')

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const price = listing ? BigInt(listing.priceAtomic) : 0n
  const own = Boolean(address && listing && address.toLowerCase() === listing.offerer.toLowerCase())

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
    if (!listing || !address || !publicClient) return
    setBusy(true)
    try {
      // Approve exactly the sale price, not max — a stale unlimited approval to any marketplace
      // is a standing risk to every token the wallet holds.
      setStep('Checking allowance…')
      const allowance = (await publicClient.readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, SEAPORT_ADDRESS],
      })) as bigint
      if (allowance < price) {
        setStep('Approve USDC…')
        const h = await writeContractAsync({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [SEAPORT_ADDRESS, price],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }

      setStep('Buying…')
      const params = toOrderParameters(reviveOrder(listing.order))
      const hash = await writeContractAsync({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'fulfillOrder',
        args: [{ parameters: params, signature: listing.signature as Hex }, CONDUIT_KEY],
        chainId: ARC_CHAIN_ID,
      })
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      await fetch('/api/studio/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderHash: listing.orderHash,
          action: 'filled',
          txHash: hash,
          buyer: address,
        }),
      }).catch(() => null)
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

  const usd = (Number(price) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })

  return (
    <PortSheet open={open && !!listing} onClose={() => { setError(''); onClose() }} title="Buy">
      <div className="pb-2">
        <div className="rounded-xl border border-hair bg-s1 px-4 py-4">
          <div className="text-[13px] text-t3">Price</div>
          <div className="mt-1 text-[28px] font-semibold tracking-display">{usd} USDC</div>
        </div>
        <p className="mt-3 text-[13px] text-t3">
          Settled atomically by Seaport — the NFT and the payment move in one transaction, with the
          creator royalty and studio fee split automatically.
        </p>
        {own ? (
          <p className="mt-3 text-[13px] text-t3">This is your own listing.</p>
        ) : null}
        {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
        <button
          type="button"
          disabled={busy || own}
          onClick={confirm}
          className="mt-5 inline-flex h-14 w-full items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {!isConnected
            ? 'Connect wallet'
            : wrongChain
              ? 'Switch to Arc'
              : own
                ? 'Your listing'
                : busy
                  ? step || 'Working…'
                  : `Buy for ${usd} USDC`}
        </button>
      </div>
    </PortSheet>
  )
}

/** JSON round-trip gives decimal strings; Seaport needs bigints. */
function reviveOrder(o: Record<string, unknown>) {
  const big = (v: unknown) => BigInt(String(v))
  const item = (i: Record<string, unknown>) => ({
    itemType: Number(i.itemType),
    token: i.token as Address,
    identifierOrCriteria: big(i.identifierOrCriteria),
    startAmount: big(i.startAmount),
    endAmount: big(i.endAmount),
  })
  return {
    offerer: o.offerer as Address,
    zone: o.zone as Address,
    offer: (o.offer as Record<string, unknown>[]).map(item),
    consideration: (o.consideration as Record<string, unknown>[]).map((i) => ({
      ...item(i),
      recipient: i.recipient as Address,
    })),
    orderType: Number(o.orderType),
    startTime: big(o.startTime),
    endTime: big(o.endTime),
    zoneHash: o.zoneHash as Hex,
    salt: big(o.salt),
    conduitKey: o.conduitKey as Hex,
    counter: big(o.counter),
  }
}
