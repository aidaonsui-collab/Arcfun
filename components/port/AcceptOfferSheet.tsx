'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { PortSheet } from './PortSheet'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  CONDUIT_KEY,
  ItemType,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  studioTreasury,
  toOrderParameters,
} from '@/lib/port/seaport'
import { reviveOrder, type Listing } from '@/lib/port/listings'
import { formatUsdc } from '@/lib/port/format'
import { atomicToUsdc } from '@/lib/port/market'

export function AcceptOfferSheet({
  offer,
  tokenId,
  ownedIds,
  open,
  onClose,
}: {
  offer: Listing | null
  /** Token the seller is filling with (required for collection offers). */
  tokenId: number
  /** When set, collection offers let the seller pick which owned item to fill with. */
  ownedIds?: number[]
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
  const [pick, setPick] = useState(tokenId)

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const collectionOffer = offer?.kind === 'collection-offer'
  const nft = (offer?.collection || '') as Address
  const fillIds = collectionOffer && ownedIds && ownedIds.length > 0 ? ownedIds : [tokenId]
  const fillId = (fillIds.includes(pick) ? pick : fillIds[0]) || tokenId

  useEffect(() => {
    setPick(ownedIds?.[0] || tokenId)
  }, [offer?.orderHash, ownedIds, tokenId])

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
    if (!offer || !address || !publicClient || !fillId) return
    setBusy(true)
    try {
      const order = reviveOrder(offer.order)
      if (collectionOffer) {
        const priceAtomic = BigInt(offer.priceAtomic)
        const [, royaltyAmount] = (await publicClient.readContract({
          address: nft,
          abi: PORT_NFT_ABI,
          functionName: 'royaltyInfo',
          args: [BigInt(fillId), priceAtomic],
        })) as [Address, bigint]
        const signedRoyalty = order.consideration
          .filter((i) => i.itemType === ItemType.ERC20 && i.recipient.toLowerCase() !== studioTreasury().toLowerCase())
          .reduce((a, i) => a + i.startAmount, 0n)
        if (royaltyAmount !== signedRoyalty) {
          throw new Error('This token’s royalty does not match the collection offer. Pick another item.')
        }
      }
      // Royalty + studio are pulled from the seller after they receive the bid.
      // Approve the amounts already baked into the signed order, not a live royalty reread.
      const needUsdc = order.consideration
        .filter((i) => i.itemType === ItemType.ERC20)
        .reduce((a, i) => a + i.startAmount, 0n)

      setStep('Checking NFT approval…')
      const approved = (await publicClient.readContract({
        address: nft,
        abi: PORT_NFT_ABI,
        functionName: 'isApprovedForAll',
        args: [address, SEAPORT_ADDRESS],
      })) as boolean
      if (!approved) {
        setStep('Approve Seaport…')
        const h = await writeContractAsync({
          address: nft,
          abi: PORT_NFT_ABI,
          functionName: 'setApprovalForAll',
          args: [SEAPORT_ADDRESS, true],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }

      if (needUsdc > 0n) {
        const allowance = (await publicClient.readContract({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, SEAPORT_ADDRESS],
        })) as bigint
        if (allowance < needUsdc) {
          setStep('Approve USDC for royalty + fee…')
          const h = await writeContractAsync({
            address: ARC.USDC,
            abi: erc20Abi,
            functionName: 'approve',
            args: [SEAPORT_ADDRESS, needUsdc],
            chainId: ARC_CHAIN_ID,
          })
          await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
        }
      }

      setStep('Accepting…')
      const params = toOrderParameters(order)
      let hash: Hex
      if (collectionOffer) {
        hash = await writeContractAsync({
          address: SEAPORT_ADDRESS,
          abi: SEAPORT_ABI,
          functionName: 'fulfillAdvancedOrder',
          args: [
            { parameters: params, numerator: 1n, denominator: 1n, signature: offer.signature as Hex, extraData: '0x' },
            [{ orderIndex: 0n, side: 1, index: 0n, identifier: BigInt(fillId), criteriaProof: [] }],
            CONDUIT_KEY,
            zeroAddress,
          ],
          chainId: ARC_CHAIN_ID,
        })
      } else {
        hash = await writeContractAsync({
          address: SEAPORT_ADDRESS,
          abi: SEAPORT_ABI,
          functionName: 'fulfillOrder',
          args: [{ parameters: params, signature: offer.signature as Hex }, CONDUIT_KEY],
          chainId: ARC_CHAIN_ID,
        })
      }
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      await fetch('/api/studio/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderHash: offer.orderHash,
          action: 'filled',
          txHash: hash,
          buyer: offer.offerer,
          tokenId: String(fillId),
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

  const usd = formatUsdc(atomicToUsdc(offer?.priceAtomic || '0'))

  return (
    <PortSheet open={open && !!offer} onClose={() => { setError(''); onClose() }} title="Accept offer">
      <div className="pb-2">
        <div className="rounded-xl border border-hair bg-s1 px-4 py-4">
          <div className="text-[13px] text-t3">
            {collectionOffer ? `Collection offer · fill with #${fillId}` : `Offer on #${fillId}`}
          </div>
          <div className="mt-1 text-[28px] font-semibold tracking-display">{usd} USDC</div>
        </div>
        {collectionOffer && fillIds.length > 1 ? (
          <label className="mt-4 block">
            <span className="text-[13px] text-t3">Item to sell</span>
            <select
              value={fillId}
              onChange={(e) => setPick(Number(e.target.value))}
              className="mt-2 h-12 w-full rounded-xl border border-hair bg-s2 px-3 text-[14px] font-semibold outline-none"
            >
              {fillIds.map((id) => (
                <option key={id} value={id}>
                  #{id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="mt-3 text-[13px] text-t3">
          Seaport pays you first, then takes royalty and studio fee from that USDC in the same
          transaction.
        </p>
        {error ? <p className="mt-3 text-[13px] text-coral">{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={confirm}
          className="mt-5 inline-flex h-14 w-full items-center justify-center rounded-xl bg-lime text-[16px] font-bold text-white disabled:opacity-50"
        >
          {!isConnected
            ? 'Connect wallet'
            : wrongChain
              ? 'Switch to Arc'
              : busy
                ? step || 'Working…'
                : `Accept ${usd} USDC`}
        </button>
      </div>
    </PortSheet>
  )
}
