'use client'

/**
 * ArcDexTradePanel — buy/sell Instant tokens with USDC on Arc Uni V3.
 * Restyled to match redesign: sticky card, buy/sell pill, large amount, USDC chip.
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
import { Loader2, AlertCircle, CheckCircle, ExternalLink } from 'lucide-react'
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
  const [detailsOpen, setDetailsOpen] = useState(false)

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
      <div className="rounded-[28px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc swap not configured — set Uni router/quoter env.
      </div>
    )
  }

  const amtNum = Number(amount) || 0
  const amountDisplay =
    mode === 'buy'
      ? amtNum > 0
        ? `$${amtNum % 1 === 0 ? amtNum.toFixed(0) : amtNum}`
        : '$0'
      : amtNum > 0
        ? amount
        : '0'

  const receiveLabel =
    quoting
      ? '…'
      : estOut != null
        ? mode === 'buy'
          ? `${fmtTok(estOut)} ${symbol}`
          : `${formatUsdc(estOut)} USDC`
        : '—'

  const payLabel =
    mode === 'buy'
      ? amtNum > 0
        ? `$${amtNum} USDC`
        : '—'
      : amtNum > 0
        ? `${amount} ${symbol}`
        : '—'

  return (
    <div className="border border-hair rounded-[28px] bg-s1 p-2 pb-5">
      <div className="flex gap-1 p-1 bg-s2 rounded-2xl">
        {(['buy', 'sell'] as const).map((m) => {
          const on = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m)
                setAmount('')
                setEstOut(null)
                setError(null)
              }}
              className="flex-1 py-3 rounded-xl text-[15px] font-semibold tracking-tightish capitalize transition-colors"
              style={{
                background: on ? (m === 'buy' ? 'var(--lime)' : 'var(--coral)') : 'transparent',
                color: on ? '#fff' : 'rgba(255,255,255,0.52)',
              }}
            >
              {m}
            </button>
          )
        })}
      </div>

      {!isConnected ? (
        <p className="text-sm text-t3 text-center py-8">Connect wallet to trade</p>
      ) : wrongChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
          disabled={switching}
          className="mx-2 mt-3 w-[calc(100%-16px)] h-14 rounded-[18px] bg-amber-500 text-black text-[17px] font-semibold flex items-center justify-center gap-2"
        >
          {switching ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
          Switch to Arc
        </button>
      ) : (
        <>
          <div className="mx-2 mt-3 p-5 rounded-[22px] bg-s2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-t2">
                {mode === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`}
              </span>
              {mode === 'buy' && (
                <div className="flex gap-1.5">
                  {BUY_PRESETS.map((v) => {
                    const on = amount === String(v)
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setAmount(String(v))}
                        className="px-3 py-1.5 rounded-[10px] text-xs font-semibold tabular-nums border border-hair transition-colors"
                        style={{
                          background: on ? 'rgba(38,118,202,0.22)' : 'rgba(255,255,255,0.07)',
                          color: on ? 'var(--limeT)' : 'rgba(255,255,255,0.58)',
                        }}
                      >
                        ${v}
                      </button>
                    )
                  })}
                </div>
              )}
              {mode === 'sell' && (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {SELL_PCTS.map((pct) => {
                    const bal = (tokenBal as bigint | undefined) ?? 0n
                    const pctAmt = bal > 0n ? (bal * BigInt(pct)) / 100n : 0n
                    const pctStr = pctAmt > 0n ? formatToken(pctAmt) : ''
                    const on = pctStr !== '' && amount === pctStr
                    return (
                      <button
                        key={pct}
                        type="button"
                        disabled={bal === 0n}
                        onClick={() => {
                          if (pctAmt <= 0n) return
                          setAmount(formatToken(pctAmt))
                        }}
                        className="px-2.5 py-1.5 rounded-[10px] text-xs font-semibold tabular-nums border border-hair transition-colors disabled:opacity-40"
                        style={{
                          background: on ? 'rgba(255,122,98,0.22)' : 'rgba(255,255,255,0.07)',
                          color: on ? 'var(--coral)' : 'rgba(255,255,255,0.58)',
                        }}
                      >
                        {pct === 100 ? 'Max' : `${pct}%`}
                      </button>
                    )
                  })}
                  <span className="text-[11px] text-t3 tabular-nums ml-0.5">
                    {fmtTok((tokenBal as bigint | undefined) ?? 0n)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 mt-3.5">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[42px] font-semibold tracking-[-0.04em] tabular-nums placeholder:text-white/20"
              />
              <span className="flex items-center gap-2 pl-1.5 pr-3.5 py-1.5 rounded-full bg-black border border-hair shrink-0">
                {mode === 'buy' ? (
                  <>
                    <span
                      className="w-[26px] h-[26px] rounded-full"
                      style={{ background: 'linear-gradient(140deg,#2775CA,#5AA9F5)' }}
                    />
                    <span className="text-sm font-semibold">USDC</span>
                  </>
                ) : (
                  <>
                    <span
                      className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-xs font-bold"
                      style={{ background: tile, color: mono }}
                    >
                      {initial}
                    </span>
                    <span className="text-sm font-semibold">{symbol}</span>
                  </>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 mt-2.5 text-sm text-t2 tabular-nums">
              ⇅ {receiveLabel}
            </div>
          </div>

          <div className="mx-2 mt-2 px-5 py-4 rounded-[22px] bg-s2 flex items-center justify-between gap-3">
            <div className="min-w-0 flex flex-col gap-1">
              <span className="text-sm font-medium text-t2">
                {mode === 'buy' ? 'Pay with' : 'You receive'}
              </span>
              {mode === 'sell' && (
                <span className="text-[22px] font-semibold tracking-tightish tabular-nums truncate">
                  {quoting ? '…' : estOut != null ? formatUsdc(estOut) : '0'}
                </span>
              )}
              {mode === 'buy' && (
                <span className="text-[22px] font-semibold tracking-tightish tabular-nums truncate">
                  {amtNum > 0 ? (amtNum % 1 === 0 ? amtNum.toFixed(0) : String(amtNum)) : '0'}
                </span>
              )}
            </div>
            <span className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full bg-black border border-hair shrink-0">
              <span
                className="w-6 h-6 rounded-full"
                style={{ background: 'linear-gradient(140deg,#2775CA,#5AA9F5)' }}
              />
              <span className="text-sm font-semibold">USDC</span>
            </span>
          </div>

          <div className="mx-5 mt-[18px] flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-t2">You receive</span>
              <span className="font-medium tabular-nums">~ {receiveLabel}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-t2">You pay</span>
              <span className="font-medium tabular-nums">~ {payLabel}</span>
            </div>

            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-3 py-1"
            >
              <span className="flex-1 h-px bg-hair2" />
              <span className="text-[13px] text-t3">Details {detailsOpen ? '⌃' : '⌄'}</span>
              <span className="flex-1 h-px bg-hair2" />
            </button>

            {detailsOpen && (
              <>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-t2">Max slippage</span>
                  <span className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-lg bg-s3 text-xs font-semibold text-t2">
                      Auto
                    </span>
                    <span className="font-semibold tabular-nums">{SLIPPAGE_BPS / 100}%</span>
                  </span>
                </div>
                <div className="flex justify-between text-[13px] text-t3">
                  <span>Route</span>
                  <span>
                    Uniswap V3 · 1% pool
                    {ARC.FEE_ROUTER !== '0x0000000000000000000000000000000000000000'
                      ? ' · fee router'
                      : ''}
                  </span>
                </div>
                <div className="flex justify-between text-[13px] text-t3">
                  <span>Balance</span>
                  <span className="tabular-nums">
                    {mode === 'buy'
                      ? `${formatUsdc((usdcBal as bigint | undefined) ?? 0n)} USDC`
                      : `${fmtTok((tokenBal as bigint | undefined) ?? 0n)} ${symbol}`}
                  </span>
                </div>
              </>
            )}
          </div>

          {error && (
            <p className="mx-5 mt-3 text-xs text-coral flex items-start gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
          {statusMsg && !error && (
            <p className="mx-5 mt-3 text-xs text-lime-t flex items-center gap-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              {statusMsg}
            </p>
          )}

          {mode === 'buy' && ((usdcBal as bigint | undefined) ?? 0n) < parseUsdc('1') && (
            <div className="mx-5 mt-3">
              <ArcBridgeCta reason="Low USDC balance on Arc" />
            </div>
          )}

          <button
            type="button"
            disabled={busy || !amount || Number(amount) <= 0}
            onClick={() => void onSubmit()}
            className="mx-5 mt-5 w-[calc(100%-40px)] h-14 rounded-[18px] text-[17px] font-semibold tracking-tightish disabled:opacity-40 transition-opacity"
            style={{
              background: mode === 'buy' ? 'var(--lime)' : 'var(--coral)',
              color: '#fff',
            }}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Working…
              </span>
            ) : needApprove ? (
              mode === 'buy' ? 'Approve USDC & buy' : `Approve ${symbol} & sell`
            ) : mode === 'buy' ? (
              `Buy ${symbol}`
            ) : (
              `Sell ${symbol}`
            )}
          </button>

          {txHash && (
            <a
              href={`${ARC_EXPLORER || 'https://arc-scan.io'}/tx/${txHash}`}
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
