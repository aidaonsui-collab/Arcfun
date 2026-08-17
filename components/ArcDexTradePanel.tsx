'use client'

/**
 * ArcDexTradePanel — buy/sell Instant tokens with USDC on Arc Uni V3.
 * Restyled to match redesign: sticky card, buy/sell pill, large amount, USDC chip.
 */
import { useState, useEffect, useRef } from 'react'
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { Loader2, AlertCircle, CheckCircle, ExternalLink } from 'lucide-react'
import { ARC, ARC_CHAIN_ID, ARC_EXPLORER } from '@/lib/contracts-arc'
import {
  arcSwapConfigured,
  arcSwapSpender,
  buildArcBuy,
  buildArcSell,
  findArcPoolFee,
  formatUsdc,
  minOutFromSlippage,
  parseUsdc,
  quoteArcBuy,
  quoteArcSell,
  withRecipient,
} from '@/lib/arc-swap'
import { formatToken, parseToken } from '@/lib/token-format'
import { ArcBridgeCta } from '@/components/ArcBridgeCta'
import { tileGradient } from '@/lib/ui-format'

const SLIPPAGE_BPS = 500 // 5% — thin Instant single-sided ranges
const BUY_PRESETS = [25, 100, 500]
/** Sell fraction of wallet balance (Max = 100). */
const SELL_PCTS = [25, 50, 75, 100] as const

function fmtTok(v: bigint): string {
  const n = Number(formatUnits(v, 6))
  if (n === 0) return '0'
  if (n < 0.0001) return n < 1e-8 ? n.toExponential(2) : '<0.0001'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function UsdcMark() {
  return (
    <span className="w-7 h-7 rounded-full bg-[#2775CA] flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden>
        <circle cx="12" cy="12" r="10" fill="#2775CA" />
        <path
          fill="#fff"
          d="M12.2 6.2c.3 0 .5.2.6.5l.1 1.1c1.4.2 2.4.9 2.4 2.1 0 1.4-1.2 2-2.6 2.2v2.7c.6-.1 1.1-.3 1.5-.6.2-.2.5-.1.6.1l.4.7c.1.2 0 .5-.2.6-.6.4-1.3.7-2.3.8v.9c0 .3-.2.5-.5.5h-.8c-.3 0-.5-.2-.5-.5v-.9c-1.5-.2-2.6-1-2.6-2.3 0-1.4 1.1-2.1 2.6-2.3V8.9c-.5.1-1 .3-1.4.6-.2.1-.5.1-.6-.1l-.4-.7c-.1-.2 0-.5.2-.6.6-.4 1.3-.7 2.2-.8v-.6c0-.3.2-.5.5-.5h.8zm.1 6.6v2.5c.7-.1 1.1-.4 1.1-1 0-.6-.3-1-1.1-1.5zm-.9-3.9v-2.3c-.6.1-1 .4-1 1 0 .5.3.9 1 1.3z"
        />
      </svg>
    </span>
  )
}

export function ArcDexTradePanel({
  token,
  symbol,
  imageUrl,
  onTraded,
}: {
  token: Address
  symbol: string
  imageUrl?: string | null
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
  const submitLock = useRef(false)

  const { isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash })
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const swapOn = arcSwapConfigured()
  const spender = arcSwapSpender()
  const { tile, mono } = tileGradient(token)
  const initial = (symbol || '?').charAt(0).toUpperCase()

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
    submitLock.current = false
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
    if (submitLock.current || busy) return
    submitLock.current = true
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
        // Same tier the quote resolved — cached, so this is not an extra RPC round trip.
        const poolFee = (await findArcPoolFee(token)) ?? undefined
        let call = buildArcBuy(token, inAmt, minOut, poolFee)
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
        const poolFee = (await findArcPoolFee(token)) ?? undefined
        const call = buildArcSell(token, inAmt, minOut, address, poolFee)
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
      submitLock.current = false
    }
  }

  if (!swapOn) {
    return (
      <div className="rounded-[28px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc swap not configured — set Uni router/quoter env.
      </div>
    )
  }

  const amtNum = Number(amount) || 0
  const payBal = mode === 'buy' ? ((usdcBal as bigint | undefined) ?? 0n) : ((tokenBal as bigint | undefined) ?? 0n)
  const payBalLabel = mode === 'buy' ? formatUsdc(payBal) : fmtTok(payBal)
  const receiveAmt =
    quoting ? '…' : estOut == null ? '0' : mode === 'buy' ? fmtTok(estOut) : formatUsdc(estOut)
  const rate = (() => {
    if (!(amtNum > 0) || estOut == null || estOut <= 0n) return null
    const out = Number(formatUnits(estOut, 6))
    if (!(out > 0)) return null
    const per = out / amtNum
    const pretty = per.toLocaleString(undefined, { maximumFractionDigits: 6 })
    return mode === 'buy' ? `1 USDC = ${pretty} ${symbol}` : `1 ${symbol} = ${pretty} USDC`
  })()

  const TokenChip = ({ kind }: { kind: 'usdc' | 'token' }) =>
    kind === 'usdc' ? (
      <span className="inline-flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-full bg-[#111318] border border-white/10">
        <UsdcMark />
        <span className="text-[15px] font-semibold">USDC</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-full bg-[#111318] border border-white/10">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="w-7 h-7 rounded-full object-cover" />
        ) : (
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: tile, color: mono }}
          >
            {initial}
          </span>
        )}
        <span className="text-[15px] font-semibold">{symbol}</span>
      </span>
    )

  return (
    <div className="rounded-[28px] border border-hair bg-[#0e1016] p-3">
      {!isConnected ? (
        <p className="text-sm text-t3 text-center py-10">Connect wallet to trade</p>
      ) : wrongChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
          disabled={switching}
          className="w-full h-14 rounded-2xl bg-amber-500 text-black text-[17px] font-bold flex items-center justify-center gap-2"
        >
          {switching ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
          Switch to Arc
        </button>
      ) : (
        <>
          <div className="rounded-[22px] bg-[#16181f] p-4">
            <div className="flex items-center justify-between text-[13px] text-white/45">
              <span>You pay</span>
              <button
                type="button"
                disabled={payBal === 0n}
                onClick={() => {
                  if (payBal <= 0n) return
                  setAmount(mode === 'buy' ? formatUsdc(payBal).replace(/,/g, '') : formatToken(payBal))
                }}
                className="tabular-nums font-medium disabled:opacity-40"
              >
                {payBalLabel}{' '}
                <span className="font-bold text-[#c6f135]">MAX</span>
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 mt-3">
              <TokenChip kind={mode === 'buy' ? 'usdc' : 'token'} />
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-right text-[34px] font-semibold tracking-[-0.04em] tabular-nums placeholder:text-white/20"
              />
            </div>
            {mode === 'buy' && (
              <div className="flex gap-1.5 mt-3">
                {BUY_PRESETS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(String(v))}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-white/45 bg-white/5 hover:text-white"
                  >
                    ${v}
                  </button>
                ))}
              </div>
            )}
            {mode === 'sell' && (
              <div className="flex gap-1.5 mt-3">
                {SELL_PCTS.filter((p) => p !== 100).map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={payBal === 0n}
                    onClick={() => {
                      const pctAmt = (payBal * BigInt(pct)) / 100n
                      if (pctAmt > 0n) setAmount(formatToken(pctAmt))
                    }}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-white/45 bg-white/5 hover:text-white disabled:opacity-40"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative z-10 -my-3 flex justify-center">
            <button
              type="button"
              aria-label="Switch buy and sell"
              onClick={() => {
                setMode((m) => (m === 'buy' ? 'sell' : 'buy'))
                setAmount('')
                setEstOut(null)
                setError(null)
              }}
              className="w-10 h-10 rounded-[12px] bg-[#16181f] border border-[#0e1016] shadow-[0_0_0_4px_#0e1016] text-white/70 hover:text-white flex items-center justify-center"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="rounded-[22px] bg-[#16181f] p-4">
            <div className="flex items-center justify-between text-[13px] text-white/45">
              <span>You receive</span>
              {estOut != null && !quoting && (
                <span className="tabular-nums text-white/35 truncate max-w-[55%]">
                  {mode === 'buy' ? formatToken(estOut) : formatUsdc(estOut)}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 mt-3">
              <TokenChip kind={mode === 'buy' ? 'token' : 'usdc'} />
              <span className="flex-1 min-w-0 text-right text-[34px] font-semibold tracking-[-0.04em] tabular-nums truncate">
                {receiveAmt}
              </span>
            </div>
          </div>

          <div className="px-1 pt-3 flex flex-col gap-2">
            {rate && <p className="text-[13px] text-white/45 m-0">{rate}</p>}
            <div className="flex items-center gap-2 text-[12px] text-white/45">
              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-black font-bold text-[#c6f135] tracking-wide">
                DEX V3
              </span>
              <span>1% fee</span>
              <span className="ml-auto inline-flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
                </svg>
                {SLIPPAGE_BPS / 100}%
              </span>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-xs text-coral flex items-start gap-1 px-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
          {statusMsg && !error && (
            <p className="mt-3 text-xs text-[#c6f135] flex items-center gap-1 px-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              {statusMsg}
            </p>
          )}

          {mode === 'buy' && payBal < parseUsdc('1') && (
            <div className="mt-3 px-1">
              <ArcBridgeCta reason="Low USDC balance on Arc" />
            </div>
          )}

          <button
            type="button"
            disabled={busy || !amount || Number(amount) <= 0}
            onClick={() => void onSubmit()}
            className="mt-4 w-full h-[56px] rounded-2xl text-[17px] font-bold tracking-wide disabled:opacity-40 transition-opacity"
            style={{
              background: mode === 'buy' ? '#c6f135' : 'var(--coral)',
              color: mode === 'buy' ? '#111' : '#fff',
            }}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Working…
              </span>
            ) : needApprove ? (
              mode === 'buy' ? 'APPROVE & BUY' : `APPROVE & SELL`
            ) : mode === 'buy' ? (
              'BUY'
            ) : (
              'SELL'
            )}
          </button>

          {txHash && (
            <a
              href={`${ARC_EXPLORER || 'https://arc-scan.org'}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1 w-full mt-3 text-[11px] text-t3 hover:text-t2"
            >
              View tx <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </>
      )}
    </div>
  )
}
