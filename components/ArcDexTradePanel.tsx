'use client'

/**
 * ArcDexTradePanel — buy/sell Instant tokens with USDC on Arc Uni V3.
 * Restyled to match redesign: sticky card, buy/sell pill, large amount, USDC chip.
 */
import { useState, useEffect, useRef } from 'react'
import { useAccount, useConnectorClient, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { Loader2, AlertCircle, CheckCircle, ExternalLink, ArrowDownUp } from 'lucide-react'
import { ARC, ARC_CHAIN_ID, ARC_ERC20_APPROVE_GAS, ARC_EXPLORER, ARC_SWAP_GAS } from '@/lib/contracts-arc'
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
import { getIncomingReferralCode } from '@/lib/crucible'
import { fmtPrice, fmtUsd, tileGradient } from '@/lib/ui-format'
import { cdnImage } from '@/lib/cdn-image'
import { WalletButton } from '@/components/WalletButton'
import { useArcErc20Balance } from '@/lib/use-arc-erc20-balance'

const SLIPPAGE_BPS = 500 // 5% — thin Instant single-sided ranges
const BUY_PRESETS = [25, 100, 500]
/** Sell fraction of wallet balance (Max = 100). */
const SELL_PCTS = [25, 50, 75, 100] as const

function fmtTok(v: bigint, decimals: number): string {
  const n = Number(formatUnits(v, decimals))
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n < 0.0001) return n < 1e-8 ? n.toExponential(2) : '<0.0001'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
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
  const { data: wallet } = useConnectorClient({ chainId: ARC_CHAIN_ID })
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
  const spender = arcSwapSpender(mode)
  const refCode = mode === 'buy' ? getIncomingReferralCode() : ''
  const { tile, mono } = tileGradient(token)
  const initial = (symbol || '?').charAt(0).toUpperCase()

  const usdcQ = useArcErc20Balance(ARC.USDC, address)
  const tokQ = useArcErc20Balance(token, address)
  const usdcBal = usdcQ.data
  const tokenBal = tokQ.data
  const refetchUsdc = usdcQ.refetch
  const refetchTok = tokQ.refetch
  const payBalPending = mode === 'buy' ? usdcQ.isPending : tokQ.isPending

  const { data: tokenDecimals } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'decimals',
    chainId: ARC_CHAIN_ID,
    query: { staleTime: 3_600_000 },
  })
  const tokDec = Number(tokenDecimals ?? ARC.TOKEN_DECIMALS) || ARC.TOKEN_DECIMALS

  const approveToken: Address = mode === 'buy' ? ARC.USDC : token
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approveToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, spender] : undefined,
    chainId: ARC_CHAIN_ID,
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
    if (!amount || Number(amount) <= 0 || !swapOn) {
      setEstOut(null)
      setError(null)
      setQuoting(false)
      return
    }
    let cancelled = false
    const run = async () => {
      setEstOut(null)
      setQuoting(true)
      try {
        const ref = mode === 'buy' ? getIncomingReferralCode() : ''
        // Wallet-first, same as RadarDEX / MAX. Server Infura is often quota-dead.
        if (wallet) {
          const local =
            mode === 'buy'
              ? await quoteArcBuy(token, parseUsdc(amount), ref, wallet)
              : await quoteArcSell(token, parseToken(amount, tokDec), wallet)
          if (cancelled) return
          if (local != null && local > 0n) {
            setEstOut(local)
            setError(null)
            return
          }
        }
        const qs = new URLSearchParams({
          token,
          side: mode,
          amount,
          ...(ref ? { ref } : {}),
        })
        const res = await fetch(`/api/arc/quote?${qs}`)
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean
          out?: string
          error?: string
        } | null
        if (cancelled) return
        if (data?.ok && data.out) {
          setEstOut(BigInt(data.out))
          setError(null)
          return
        }
        setEstOut(null)
        setError(
          res.status >= 500
            ? 'Quote RPC is busy — retry. Your wallet is fine.'
            : data?.error || 'No quote for this size.',
        )
      } catch {
        if (!cancelled) {
          setEstOut(null)
          setError('Quote failed. Retry in a moment.')
        }
      } finally {
        if (!cancelled) setQuoting(false)
      }
    }
    const t = setTimeout(run, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [amount, mode, token, swapOn, wallet, tokDec])

  const needApprove = (() => {
    if (!amount || Number(amount) <= 0) return false
    const need = mode === 'buy' ? parseUsdc(amount) : parseToken(amount, tokDec)
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
      if (needApprove) {
        const inAmt = mode === 'buy' ? parseUsdc(amount) : parseToken(amount, tokDec)
        setStatusMsg(mode === 'buy' ? 'Approve USDC…' : `Approve ${symbol}…`)
        await writeContractAsync({
          address: mode === 'buy' ? ARC.USDC : token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, inAmt],
          chainId: ARC_CHAIN_ID,
          gas: ARC_ERC20_APPROVE_GAS,
        })
        void refetchAllowance()
        if (estOut == null || estOut <= 0n) {
          setStatusMsg('Approved. Waiting for a quote…')
          setBusy(false)
          submitLock.current = false
          return
        }
      }
      if (estOut == null || estOut <= 0n) {
        throw new Error('No quote yet. Wait a moment or try a smaller amount.')
      }
      if (mode === 'buy') {
        const inAmt = parseUsdc(amount)
        const minOut = minOutFromSlippage(estOut, SLIPPAGE_BPS)
        setStatusMsg('Confirm in wallet…')
        // Same tier the quote resolved — cached, so this is not an extra RPC round trip.
        const poolFee = (await findArcPoolFee(token, wallet)) ?? undefined
        let call = buildArcBuy(token, inAmt, minOut, poolFee, refCode)
        call = withRecipient(call, address)
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_SWAP_GAS,
        })
        setTxHash(hash)
        setStatusMsg('Confirming…')
      } else {
        const inAmt = parseToken(amount, tokDec)
        const minOut = minOutFromSlippage(estOut, SLIPPAGE_BPS)
        setStatusMsg('Confirm in wallet…')
        const poolFee = (await findArcPoolFee(token, wallet)) ?? undefined
        const call = buildArcSell(token, inAmt, minOut, address, poolFee)
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_SWAP_GAS,
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
  const payBalLabel = payBalPending ? '…' : mode === 'buy' ? formatUsdc(payBal) : fmtTok(payBal, tokDec)
  const receiveAmt =
    quoting && amtNum > 0
      ? '…'
      : estOut == null
        ? '0'
        : mode === 'buy'
          ? fmtTok(estOut, tokDec)
          : formatUsdc(estOut)
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
          <img src={cdnImage(imageUrl, 28)} alt="" className="w-7 h-7 rounded-full object-cover" />
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

  const feeUsd =
    mode === 'buy'
      ? amtNum * 0.01
      : estOut != null && estOut > 0n
        ? Number(formatUnits(estOut, 6)) * (0.01 / 0.99)
        : 0
  const pricePer =
    amtNum > 0 && estOut != null && estOut > 0n
      ? mode === 'buy'
        ? amtNum / Number(formatUnits(estOut, tokDec))
        : Number(formatUnits(estOut, 6)) / amtNum
      : null

  return (
    <div className="rounded-[20px] bg-s1 border border-hair p-5">
      <div className="flex rounded-full bg-s2 p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setMode(s)
              setAmount('')
              setEstOut(null)
              setError(null)
            }}
            className={`h-9 flex-1 rounded-full text-sm font-medium capitalize transition-colors duration-150 ${
              mode === s ? 'bg-lime text-white' : 'text-t3 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-xs text-t3">
            {mode === 'buy' ? 'You pay · USDC' : `You sell · $${symbol}`}
          </label>
          <div className="mt-2 flex items-center gap-2 h-12 rounded-xl bg-s2 border border-hair px-3">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              placeholder="0"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-lg tabular-nums placeholder:text-t3"
            />
            <TokenChip kind={mode === 'buy' ? 'usdc' : 'token'} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-t3">
            <span>Wallet {payBalLabel}</span>
            <button
              type="button"
              disabled={payBalPending || payBal === 0n}
              onClick={() => {
                if (payBalPending || payBal <= 0n) return
                setAmount(
                  mode === 'buy' ? formatUsdc(payBal).replace(/,/g, '') : formatToken(payBal, tokDec),
                )
              }}
              className="text-white/80 hover:text-white disabled:opacity-40"
            >
              Max
            </button>
          </div>
          {mode === 'buy' ? (
            <div className="mt-2 flex gap-1.5">
              {BUY_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAmount(String(v))}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-t3 bg-s2 hover:text-white"
                >
                  ${v}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-2 flex gap-1.5">
              {SELL_PCTS.filter((p) => p !== 100).map((pct) => (
                <button
                  key={pct}
                  type="button"
                  disabled={payBalPending || payBal === 0n}
                  onClick={() => {
                    const pctAmt = (payBal * BigInt(pct)) / 100n
                    if (pctAmt > 0n) setAmount(formatToken(pctAmt, tokDec))
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-t3 bg-s2 hover:text-white disabled:opacity-40"
                >
                  {pct}%
                </button>
              ))}
            </div>
          )}

          <div className="my-4 flex justify-center text-t3">
            <ArrowDownUp className="size-4" />
          </div>

          <div className="rounded-xl bg-s2 px-4 py-3">
            <div className="text-xs text-t3">You receive</div>
            <div className="mt-1 text-lg font-medium tabular-nums">
              {receiveAmt}{' '}
              <span className="text-sm text-t3">{mode === 'buy' ? symbol : 'USDC'}</span>
            </div>
          </div>

          <div className="mt-3 flex justify-between text-xs text-t3">
            <span>Price</span>
            <span className="tabular-nums">
              {pricePer != null ? `${fmtPrice(pricePer)} / token` : '—'}
            </span>
          </div>
          <div className="mt-1 flex justify-between text-xs text-t3">
            <span>1% fee</span>
            <span className="tabular-nums">{amtNum > 0 ? fmtUsd(feeUsd) : '$0'}</span>
          </div>

          {error && (
            <p className="mt-3 mb-0 text-xs text-coral flex items-start gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
          {statusMsg && !error && (
            <p className="mt-3 mb-0 text-xs text-lime-t flex items-center gap-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              {statusMsg}
            </p>
          )}

          {mode === 'buy' && refCode ? (
            <p className="mt-3 mb-0 text-[12px] text-t3">
              Buying through <span className="text-white/80 font-semibold">{refCode}</span>
              {' · '}0.05% of this buy goes to that link
            </p>
          ) : null}

          {!isConnected || wrongChain ? (
            <div className="mt-5">
              <WalletButton variant="panel" />
            </div>
          ) : (
            <button
              type="button"
              disabled={
                busy ||
                quoting ||
                !amount ||
                Number(amount) <= 0 ||
                (estOut == null && !needApprove)
              }
              onClick={() => void onSubmit()}
              className={`mt-5 w-full h-11 rounded-full text-sm font-semibold tracking-tightish disabled:opacity-40 transition-colors ${
                mode === 'buy' ? 'bg-lime text-white hover:bg-lime-2' : 'bg-coral text-white'
              }`}
            >
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Working…
                </span>
              ) : needApprove ? (
                mode === 'buy' ? `Approve & buy $${symbol}` : `Approve & sell $${symbol}`
              ) : mode === 'buy' ? (
                `Buy $${symbol}`
              ) : (
                `Sell $${symbol}`
              )}
            </button>
          )}

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

          <p className="mt-3 mb-0 text-center text-[11px] text-t3">
            1% quote fee into Crucible, creator, burn, platform.
          </p>
    </div>
  )
}
