'use client'

/**
 * Claim Instant creator LP fees routed to an X handle's HandlePay vault.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { erc20Abi, formatUnits, type Address, type Hex } from 'viem'
import { Loader2, ExternalLink } from 'lucide-react'
import {
  HANDLE_PAY_FACTORY,
  HANDLE_PAY_FACTORY_ABI,
  HANDLE_PAY_ABI,
  handleHashFor,
  handlePayEnabled,
  handlePayGiftId,
  HANDLE_PAY_CLAIM_GAS,
  normaliseXHandle,
} from '@/lib/handle-pay'
import { ARC, ARC_CHAIN_ID, ARC_EXPLORER, arcPublicClient } from '@/lib/contracts-arc'

const ZERO_RE = /^0x0+$/i

interface VaultState {
  handle: string
  vault: Address
  deployed: boolean
  usdcRaw: bigint
  nativeWei: bigint
}

export function HandlePayClaimCard({ initialHandle = '' }: { initialHandle?: string }) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [input, setInput] = useState(initialHandle)
  const [state, setState] = useState<VaultState | null>(null)
  const [busy, setBusy] = useState<'lookup' | 'verify' | 'claim' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifyToken, setVerifyToken] = useState<string | null>(null)
  const [verifiedAs, setVerifiedAs] = useState<string | null>(null)
  const [claimTx, setClaimTx] = useState<string | null>(null)

  const lookup = useCallback(async (raw: string, resetClaim = true) => {
    const handle = normaliseXHandle(raw)
    if (!handle) return
    setBusy('lookup')
    setError(null)
    if (resetClaim) setClaimTx(null)
    try {
      const client = arcPublicClient()
      const hash = handleHashFor(handle)
      const [deployedVault, predicted] = await Promise.all([
        client.readContract({
          address: HANDLE_PAY_FACTORY,
          abi: HANDLE_PAY_FACTORY_ABI,
          functionName: 'vaultOf',
          args: [hash],
        }) as Promise<Address>,
        client.readContract({
          address: HANDLE_PAY_FACTORY,
          abi: HANDLE_PAY_FACTORY_ABI,
          functionName: 'computeVault',
          args: [hash],
        }) as Promise<Address>,
      ])
      const deployed = !ZERO_RE.test(deployedVault)
      const vault = deployed ? deployedVault : predicted
      const [nativeWei, usdcRaw] = deployed
        ? await Promise.all([
            client.getBalance({ address: vault }),
            client.readContract({
              address: ARC.USDC,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [vault],
            }) as Promise<bigint>,
          ])
        : [0n, 0n]
      setState({ handle, vault, deployed, usdcRaw, nativeWei })
    } catch (e) {
      setError((e as Error).message || 'Lookup failed')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search)
    const h = normaliseXHandle(q.get('h') || q.get('handle') || initialHandle || '')
    if (!h) return
    setInput(h)
    void lookup(h)
    try {
      const raw = sessionStorage.getItem(`handlepay:verify:${handlePayGiftId(h)}`)
      if (!raw) return
      const s = JSON.parse(raw) as { verifyToken: string; username: string; ts: number }
      if (s.verifyToken && Date.now() - (s.ts || 0) < 15 * 60 * 1000) {
        setVerifyToken(s.verifyToken)
        setVerifiedAs(s.username)
      }
    } catch {
      /* re-verify */
    }
  }, [lookup, initialHandle])

  const startVerify = async () => {
    if (!state || !address) return
    setBusy('verify')
    setError(null)
    try {
      const res = await fetch('/api/handle-pay/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: state.handle, walletAddress: address }),
      })
      const data = (await res.json()) as { authUrl?: string; error?: string }
      if (!res.ok) throw new Error(data.error || 'Could not start verification')
      window.location.assign(data.authUrl!)
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const claim = async () => {
    if (!state || !address || !verifyToken) return
    setBusy('claim')
    setError(null)
    try {
      if (chainId !== ARC_CHAIN_ID) await switchChain({ chainId: ARC_CHAIN_ID })
      const vRes = await fetch('/api/handle-pay/voucher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifyToken, handle: state.handle, recipient: address }),
      })
      const vData = (await vRes.json()) as { signature?: string; vault?: string; error?: string }
      if (!vRes.ok || !vData.signature) {
        throw new Error(vData.error || 'Could not authorize claim — re-verify with X')
      }
      const hash = await writeContractAsync({
        address: vData.vault as Address,
        abi: HANDLE_PAY_ABI,
        functionName: 'claim',
        args: [address, [ARC.USDC], vData.signature as Hex],
        chainId: ARC_CHAIN_ID,
        gas: HANDLE_PAY_CLAIM_GAS,
      })
      try {
        sessionStorage.removeItem(`handlepay:verify:${handlePayGiftId(state.handle)}`)
      } catch {
        /* ignore */
      }
      setClaimTx(hash)
      setVerifyToken(null)
      setVerifiedAs(null)
      await lookup(state.handle, false)
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string }
      const msg = m.shortMessage || m.message || 'Claim failed'
      setError(msg.length > 180 ? msg.slice(0, 180) + '…' : msg)
    } finally {
      setBusy(null)
    }
  }

  if (!handlePayEnabled()) return null

  const usdc = state ? Number(formatUnits(state.usdcRaw, 6)) : 0
  const canClaim = !!state?.deployed && (state.usdcRaw > 0n || state.nativeWei > 0n)

  return (
    <div className="rounded-[22px] border border-hair bg-s1 p-5 space-y-4">
      <div>
        <h1 className="m-0 text-xl font-semibold tracking-tight">Pay to @handle</h1>
        <p className="mt-1.5 mb-0 text-[13px] text-t3 leading-snug">
          Tokens launched to an X handle accrue Instant creator LP fees here. Verify the handle,
          then sweep to your wallet. No expiry.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void lookup(input)
          }}
          placeholder="@handle or x.com/handle"
          className="flex-1 h-11 rounded-2xl bg-s2 px-4 text-sm text-white outline-none border border-hair focus:border-lime-line placeholder:text-white/30"
        />
        <button
          type="button"
          onClick={() => void lookup(input)}
          disabled={busy === 'lookup' || !normaliseXHandle(input)}
          className="h-11 px-4 rounded-2xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-40"
        >
          {busy === 'lookup' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
        </button>
      </div>

      {state && (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-2xl bg-s2 border border-hair px-4 py-3">
            <div>
              <p className="m-0 text-sm font-semibold text-white">@{state.handle}</p>
              <a
                href={`${ARC_EXPLORER}/address/${state.vault}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-t3 hover:text-lime-t inline-flex items-center gap-1 font-mono"
              >
                {state.vault.slice(0, 10)}…{state.vault.slice(-6)} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="text-right">
              <p className="m-0 text-lg font-semibold tabular-nums text-lime-t">{usdc.toFixed(2)} USDC</p>
              <p className="mt-0.5 mb-0 text-[11px] text-t3">
                {state.deployed
                  ? 'accrued creator fees'
                  : 'no vault yet — accrues once a token launches for this handle'}
              </p>
            </div>
          </div>

          {claimTx && (
            <p className="m-0 text-xs text-lime-t">
              Claimed.{' '}
              <a
                className="underline"
                href={`${ARC_EXPLORER}/tx/${claimTx}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View transaction
              </a>
            </p>
          )}

          {canClaim &&
            (!isConnected ? (
              <p className="m-0 text-[13px] text-t2">Connect a wallet to claim.</p>
            ) : verifyToken ? (
              <button
                type="button"
                onClick={() => void claim()}
                disabled={busy === 'claim' || switching}
                className="w-full h-11 rounded-2xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {busy === 'claim' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Claiming…
                  </>
                ) : (
                  `Claim as @${verifiedAs} → your wallet`
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startVerify()}
                disabled={busy === 'verify'}
                className="w-full h-11 rounded-2xl border border-lime-line bg-s2 text-sm font-semibold text-lime-t hover:bg-white/5 inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy === 'verify' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Redirecting to X…
                  </>
                ) : (
                  'Verify with X to claim'
                )}
              </button>
            ))}
        </div>
      )}

      {error && <p className="m-0 text-xs text-coral">{error}</p>}
    </div>
  )
}
