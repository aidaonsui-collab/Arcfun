'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { formatUnits } from 'viem'
import { Loader2 } from 'lucide-react'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { useArcErc20Balance } from '@/lib/use-arc-erc20-balance'
import {
  addOrSwitchArc,
  connectToArc,
  formatSwitchError,
  isBaseLockedWallet,
  uniqueConnectors,
  walletLabel,
} from '@/lib/arc-wallet'

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Arc ERC-20 USDC is 6dp; same economic balance as native gas (18dp / 1e12). */
function fmtBal(raw: bigint | undefined, pending: boolean): string {
  if (raw == null) return pending ? '…' : '—'
  const n = Number(formatUnits(raw, 6))
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

export function WalletButton({
  variant = 'header',
}: {
  variant?: 'header' | 'panel'
}) {
  const { address, isConnected, chainId, connector } = useAccount()
  const { connect, connectors, isPending, error: connectErr } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChainAsync, isPending: switching, error: switchErr } = useSwitchChain()
  const onArc = isConnected && chainId === ARC_CHAIN_ID
  const wrongChain = isConnected && chainId != null && chainId !== ARC_CHAIN_ID
  const wallets = uniqueConnectors(connectors)
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState('')
  const wrap = useRef<HTMLDivElement>(null)

  // Public wagmi useBalance hangs on baracat (same bug that left MAX at 0).
  // Wallet RPC balanceOf is the path the trade panel already uses.
  const usdcQ = useArcErc20Balance(ARC.USDC, onArc ? address : undefined)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (onArc) {
      setOpen(false)
      setHint('')
    }
  }, [onArc])

  async function switchToArc() {
    setHint('')
    try {
      await switchChainAsync({ chainId: ARC_CHAIN_ID })
    } catch (err) {
      try {
        await addOrSwitchArc()
      } catch (err2) {
        const locked = isBaseLockedWallet(connector)
        const extra = locked
          ? ' Coinbase / Base wallet cannot add Arc. Connect MetaMask, Rabby, or WalletConnect instead.'
          : ''
        setHint(formatSwitchError(err2 ?? err) + extra)
        setOpen(true)
      }
    }
  }

  const menu = (
    <div
      className={
        variant === 'header'
          ? 'absolute right-0 top-[calc(100%+8px)] z-50 w-[260px] rounded-2xl border border-hair bg-s2 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]'
          : 'mt-3 rounded-2xl border border-hair bg-[#16181f] p-1.5'
      }
    >
      {wallets.map((c) => (
        <button
          key={`${c.type}:${c.id}:${c.name}`}
          type="button"
          disabled={isPending}
          onClick={() => {
            setHint('')
            connectToArc(connect, wallets, c)
          }}
          className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold text-white hover:bg-white/5 disabled:opacity-50"
        >
          <span>{walletLabel(c)}</span>
          {isBaseLockedWallet(c) ? <span className="text-[11px] font-medium text-t3">Base</span> : null}
        </button>
      ))}
      {isConnected ? (
        <button
          type="button"
          onClick={() => {
            disconnect()
            setOpen(false)
          }}
          className="mt-0.5 flex w-full rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold text-t3 hover:bg-white/5 hover:text-white"
        >
          Disconnect
        </button>
      ) : null}
      {hint ? <p className="px-3 py-2 text-[12px] font-medium leading-snug text-amber-300">{hint}</p> : null}
      {connectErr && !hint ? (
        <p className="px-3 py-2 text-[12px] font-medium leading-snug text-amber-300">
          {formatSwitchError(connectErr)}
        </p>
      ) : null}
    </div>
  )

  if (variant === 'panel') {
    if (!isConnected) {
      return (
        <div ref={wrap} className="py-4">
          <button
            type="button"
            disabled={isPending}
            onClick={() => (wallets.length > 1 ? setOpen((o) => !o) : connectToArc(connect, wallets))}
            className="flex h-14 w-full items-center justify-center rounded-2xl bg-lime text-[17px] font-bold text-[#111] disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect wallet'}
          </button>
          {open ? menu : null}
        </div>
      )
    }
    if (wrongChain || !onArc) {
      return (
        <div ref={wrap} className="py-2">
          <button
            type="button"
            disabled={switching}
            onClick={() => void switchToArc()}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 text-[17px] font-bold text-black disabled:opacity-50"
          >
            {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {switching ? 'Switching…' : 'Switch to Arc'}
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 w-full text-center text-[13px] font-semibold text-t3 hover:text-white"
          >
            Use a different wallet
          </button>
          {switchErr && !hint ? (
            <p className="mt-2 text-center text-[12px] text-amber-300">{formatSwitchError(switchErr)}</p>
          ) : null}
          {open ? menu : null}
          {hint && !open ? <p className="mt-2 text-center text-[12px] text-amber-300">{hint}</p> : null}
        </div>
      )
    }
    return null
  }

  if (!isConnected || !address) {
    return (
      <div ref={wrap} className="relative">
        <button
          type="button"
          disabled={isPending}
          onClick={() => (wallets.length > 1 ? setOpen((o) => !o) : connectToArc(connect, wallets))}
          className="h-9 px-3 sm:px-4 rounded-xl bg-s2 border border-hair text-white text-sm font-semibold hover:bg-s3 disabled:opacity-50 transition-colors"
        >
          {isPending ? '…' : 'Connect'}
        </button>
        {open ? menu : null}
      </div>
    )
  }

  return (
    <div ref={wrap} className="relative flex items-center gap-2">
      {wrongChain || !onArc ? (
        <button
          type="button"
          disabled={switching}
          onClick={() => void switchToArc()}
          className="h-9 px-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
        >
          {switching ? 'Switching…' : 'Switch to Arc'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`h-9 flex items-center gap-2.5 pl-3.5 pr-1.5 rounded-xl border text-sm font-semibold tabular-nums tracking-tightish transition-colors ${
          wrongChain || !onArc
            ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
            : 'border-hair bg-s2 text-white hover:bg-s3'
        }`}
        title={wrongChain || !onArc ? 'Wrong network — switch to Arc' : 'Wallet'}
      >
        {onArc ? (
          <span className="hidden sm:inline">{fmtBal(usdcQ.data, usdcQ.isPending)}</span>
        ) : (
          <span className="text-t3 text-xs">{short(address)}</span>
        )}
        <span
          className="w-6 h-6 rounded-lg shrink-0"
          style={{ background: 'linear-gradient(140deg,#6DB3F2,#1D5FA8)' }}
        />
      </button>
      {open ? menu : null}
    </div>
  )
}
