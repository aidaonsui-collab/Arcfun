'use client'

/**
 * Pay nanogas USDC (x402 exact / EIP-3009) then the bot Instant-creates.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount, useConnect, useSignTypedData, useSwitchChain } from 'wagmi'
import { type Address, type Hex } from 'viem'
import { Loader2 } from 'lucide-react'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'

type Requirements = {
  scheme: string
  network: string
  maxAmountRequired: string
  asset: Address
  payTo: Address
  extra: { name: string; version: string; decimals: number; chainId: number }
}

type InvoiceInfo = { tweetId: string; handle: string; name: string; symbol: string }

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

function randomNonce(): Hex {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return `0x${Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hex
}

export function BlitzPayDesk({ tweetId }: { tweetId: string }) {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { signTypedDataAsync } = useSignTypedData()

  const [priceLabel, setPriceLabel] = useState('$0.01')
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null)
  const [req, setReq] = useState<Requirements | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ token: Address; tx: Hex } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/arc/blitz/launch?tweet=${encodeURIComponent(tweetId)}`)
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `invoice ${r.status}`)
        if (cancelled) return
        setInvoice(j.invoice)
        setPriceLabel(j.priceLabel || '$0.01')
        setReq(j.accepts?.[0] || null)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'invoice failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tweetId])

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  async function pay() {
    if (!address || !req || !invoice) return
    setBusy(true)
    setError(null)
    try {
      const value = BigInt(req.maxAmountRequired)
      const validAfter = 0n
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600)
      const nonce = randomNonce()
      const signature = await signTypedDataAsync({
        domain: {
          name: req.extra.name,
          version: req.extra.version,
          chainId: req.extra.chainId,
          verifyingContract: req.asset,
        },
        types: AUTH_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: address,
          to: req.payTo,
          value,
          validAfter,
          validBefore,
          nonce,
        },
      })
      const payload = {
        x402Version: 1,
        scheme: 'exact',
        network: req.network,
        payload: {
          signature,
          authorization: {
            from: address,
            to: req.payTo,
            value: value.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      }
      const header = btoa(JSON.stringify(payload))
      const res = await fetch(`/api/arc/blitz/launch?tweet=${encodeURIComponent(tweetId)}`, {
        method: 'POST',
        headers: { 'X-PAYMENT': header },
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `pay ${res.status}`)
      setDone({ token: j.token, tx: j.tx })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'payment failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-md">
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-lime-t">Blitz · nanogas</p>
      <h1 className="mt-2 text-[32px] font-semibold tracking-tightish">Pay to launch</h1>
      {loading ? (
        <p className="mt-4 text-t2 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading invoice…
        </p>
      ) : error && !invoice ? (
        <p className="mt-4 text-red-300 text-[15px]">{error}</p>
      ) : invoice && req ? (
        <>
          <p className="mt-3 text-t2 text-[15px] leading-relaxed">
            @{invoice.handle} asked to Instant-create <span className="text-white font-medium">{invoice.name}</span>{' '}
            ({invoice.symbol}) on Arc. Pay {priceLabel} USDC (6dp). The keeper broadcasts it; you
            sign, no gas. Creator LP fees still buy and burn $EVE.
          </p>
          {done ? (
            <div className="mt-6 space-y-3">
              <p className="text-lime-t font-medium">Deployed.</p>
              <Link href={`/token/${done.token}`} className="text-white underline">
                Trade {invoice.symbol}
              </Link>
            </div>
          ) : (
            <>
              {error ? <p className="mt-4 text-red-300 text-[14px]">{error}</p> : null}
              {!isConnected ? (
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => connect({ connector: connectors[0] })}
                  className="w-full mt-6 h-14 rounded-[18px] bg-lime text-white text-[17px] font-semibold disabled:opacity-50"
                >
                  {connecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              ) : wrongChain ? (
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
                  className="w-full mt-6 h-14 rounded-[18px] bg-amber-500 text-black text-[17px] font-semibold disabled:opacity-50"
                >
                  {switching ? 'Switching…' : 'Switch to Arc'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pay()}
                  className="w-full mt-6 h-14 rounded-[18px] bg-lime text-white text-[17px] font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                  {busy ? 'Paying…' : `Pay ${priceLabel} USDC`}
                </button>
              )}
            </>
          )}
        </>
      ) : null}
      <p className="mt-8 text-[13px] text-t2">
        Asset {ARC.USDC.slice(0, 10)}… · chain {ARC_CHAIN_ID}
      </p>
    </div>
  )
}
