'use client'

/**
 * ArcDexTradePanel — buy/sell Instant tokens with USDC on Arc Uni V3.
 * Routes through RobinFeeRouter when configured (1% platform skim), else SwapRouter02.
 */
import { useState, useEffect } from 'react'
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { Loader2, AlertCircle, ArrowDown, CheckCircle, ExternalLink } from 'lucide-react'
import { ARC, ARC_CHAIN_ID, ARC_EXPLORER } from '@/lib/contracts-arc'
import {
  arcSwapConfigured,
  arcSwapSpender,
  buildArcBuy,
  buildArcSell,
  formatUsdc,
  minOutFromSlippage,
  parseUsdc,
  quoteArcBuy,
  quoteArcSell,
  withRecipient,
} from '@/lib/arc-swap'
import { formatToken, parseToken } from '@/lib/token-format'
import { ArcBridgeCta } from '@/components/ArcBridgeCta'

const SLIPPAGE_BPS = 500 // 5% — thin Instant single-sided ranges
const BUY_PRESETS = ['1', '5', '10', '50']

function fmtTok(v: bigint): string {
  const n = Number(formatUnits(v, 6))
  if (n === 0) return '0'
  if (n < 0.0001) return n < 1e-8 ? n.toExponential(2) : '<0.0001'
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export function ArcDexTradePanel({
  token,
  symbol,
  onTraded,
}: {
  token: Address
  symbol: string
  onTraded?: () => void
}) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [estOut, setEstOut] = useState<bigint | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const { isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash })
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const swapOn = arcSwapConfigured()
  const spender = arcSwapSpender()

  const { data: usdcBal, refetch: refetchUsdc } = useReadContract({
    address: ARC.USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

  const { data: tokenBal, refetch: refetchTok } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

  const approveToken: Address = mode === 'buy' ? ARC.USDC : token
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approveToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, spender] : undefined,
    query: { enabled: !!address },
  })

  useEffect(() => {
    if (!mined) return
    setStatusMsg('Confirmed ✓')
    setBusy(false)
    setAmount('')
    setEstOut(null)
    void refetchUsdc()
    void refetchTok()
    void refetchAllowance()
    onTraded?.()
  }, [mined, onTraded, refetchUsdc, refetchTok, refetchAllowance])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setEstOut(null)
      setError(null)
      if (!amount || Number(amount) <= 0 || !swapOn) return
      setQuoting(true)
      try {
        if (mode === 'buy') {
          const inAmt = parseUsdc(amount)
          if (inAmt <= 0n) return
          const q = await quoteArcBuy(token, inAmt)
          if (!cancelled) setEstOut(q)
        } else {
          const inAmt = parseToken(amount)
          if (inAmt <= 0n) return
          const q = await quoteArcSell(token, inAmt)
          if (!cancelled) setEstOut(q)
        }
      } catch {
        if (!cancelled) setEstOut(null)
      } finally {
        if (!cancelled) setQuoting(false)
      }
    }
    const t = setTimeout(run, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [amount, mode, token, swapOn])

  const needApprove = (() => {
    if (!amount || Number(amount) <= 0) return false
    const need = mode === 'buy' ? parseUsdc(amount) : parseToken(amount)
    return (allowance as bigint | undefined ?? 0n) < need
  })()

  const onSubmit = async () => {
    if (!address || !amount || Number(amount) <= 0) return
    setError(null)
    setBusy(true)
    setStatusMsg('')
    try {
      if (mode === 'buy') {
        const inAmt = parseUsdc(amount)
        const quoted = estOut ?? (await quoteArcBuy(token, inAmt)) ?? 0n
        const minOut = minOutFromSlippage(quoted, SLIPPAGE_BPS)
        if (needApprove) {
          setStatusMsg('Approve USDC…')
          await writeContractAsync({
            address: ARC.USDC,
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, inAmt],
            chainId: ARC_CHAIN_ID,
          })
          void refetchAllowance()
        }
        setStatusMsg('Buying…')
        let call = buildArcBuy(token, inAmt, minOut)
        call = withRecipient(call, address)
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
        })
        setTxHash(hash)
        setStatusMsg('Confirming…')
      } else {
        const inAmt = parseToken(amount)
        const quoted = estOut ?? (await quoteArcSell(token, inAmt)) ?? 0n
        const minOut = minOutFromSlippage(quoted, SLIPPAGE_BPS)
        if (needApprove) {
          setStatusMsg(`Approve ${symbol}…`)
          await writeContractAsync({
            address: token,
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, inAmt],
            chainId: ARC_CHAIN_ID,
          })
          void refetchAllowance()
        }
        setStatusMsg('Selling…')
        const call = buildArcSell(token, inAmt, minOut, address)
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
        })
        setTxHash(hash)
        setStatusMsg('Confirming…')
      }
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(e)
      setError(msg.length > 160 ? msg.slice(0, 160) + '…' : msg)
      setBusy(false)
      setStatusMsg('')
    }
  }

  if (!swapOn) {
    return (
      <div className="rounded-[18px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc swap not configured — set Uni router/quoter env.
      </div>
    )
  }

  return (
    <div className="rounded-[18px] border border-[var(--cp-line)] bg-[var(--cp-card)] p-4 space-y-3">
      <div className="flex gap-1 p-1 rounded-xl bg-black/30">
        {(['buy', 'sell'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setAmount(''); setEstOut(null); setError(null) }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold capitalize transition-colors ${
              mode === m
                ? m === 'buy'
                  ? 'bg-emerald-500 text-black'
                  : 'bg-rose-500 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {!isConnected ? (
        <p className="text-xs text-gray-500 text-center py-2">Connect wallet to trade</p>
      ) : wrongChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
          disabled={switching}
          className="w-full py-2.5 rounded-xl bg-amber-500 text-black text-sm font-semibold flex items-center justify-center gap-2"
        >
          {switching ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
          Switch to Arc
        </button>
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-gray-500">
              <span>{mode === 'buy' ? 'You pay (USDC)' : `You sell ($${symbol})`}</span>
              <button
                type="button"
                className="hover:text-gray-300"
                onClick={() => {
                  if (mode === 'buy') {
                    const bal = (usdcBal as bigint | undefined) ?? 0n
                    setAmount(formatUnits(bal, 6))
                  } else {
                    const bal = (tokenBal as bigint | undefined) ?? 0n
                    setAmount(formatUnits(bal, 6))
                  }
                }}
              >
                bal{' '}
                {mode === 'buy'
                  ? formatUsdc((usdcBal as bigint | undefined) ?? 0n)
                  : fmtTok((tokenBal as bigint | undefined) ?? 0n)}
              </button>
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-lg font-mono outline-none focus:border-sky-500/40"
            />
            {mode === 'buy' && (
              <div className="flex gap-1.5">
                {BUY_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAmount(p)}
                    className="flex-1 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 text-gray-400"
                  >
                    ${p}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-center">
            <ArrowDown className="w-4 h-4 text-gray-600" />
          </div>

          <div className="rounded-xl bg-black/30 border border-white/5 px-3 py-3 space-y-1">
            <p className="text-[11px] text-gray-500">
              You receive {mode === 'buy' ? `$${symbol}` : 'USDC'}
            </p>
            <p className="text-lg font-mono text-white">
              {quoting ? (
                <Loader2 className="w-4 h-4 animate-spin inline" />
              ) : estOut != null ? (
                mode === 'buy' ? fmtTok(estOut) : formatUsdc(estOut)
              ) : (
                '—'
              )}
            </p>
            <p className="text-[10px] text-gray-600">
              Uni V3 · 1% pool · {ARC.FEE_ROUTER !== '0x0000000000000000000000000000000000000000' ? '1% RobinSwap fee' : 'direct router'} · {SLIPPAGE_BPS / 100}% slip
            </p>
          </div>

          {error && (
            <p className="text-xs text-rose-400 flex items-start gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
          {statusMsg && !error && (
            <p className="text-xs text-sky-300 flex items-center gap-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              {statusMsg}
            </p>
          )}

          {mode === 'buy' && ((usdcBal as bigint | undefined) ?? 0n) < parseUsdc('1') && (
            <ArcBridgeCta reason="Low USDC balance on Arc" />
          )}

          <button
            type="button"
            disabled={busy || !amount || Number(amount) <= 0}
            onClick={() => void onSubmit()}
            className={`w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-40 ${
              mode === 'buy' ? 'bg-emerald-500 hover:bg-emerald-400 text-black' : 'bg-rose-500 hover:bg-rose-400 text-white'
            }`}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Working…
              </span>
            ) : needApprove ? (
              mode === 'buy' ? 'Approve USDC & buy' : `Approve ${symbol} & sell`
            ) : mode === 'buy' ? (
              `Buy $${symbol}`
            ) : (
              `Sell $${symbol}`
            )}
          </button>

          {txHash && (
            <a
              href={`${ARC_EXPLORER || 'https://arcscan.app'}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1 w-full text-[11px] text-gray-500 hover:text-gray-300"
            >
              View tx <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </>
      )}
    </div>
  )
}
