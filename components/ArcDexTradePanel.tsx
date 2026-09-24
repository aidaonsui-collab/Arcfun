'use client'

/**
 * ArcDexTradePanel — buy/sell Instant tokens on Arc.
 * V3 Instant is TOKEN/USDC. V4 Instant is TOKEN/{quote} (USDC, cirBTC, USYC, …).
 */
import { useState, useEffect, useRef } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { Loader2, AlertCircle, CheckCircle, ExternalLink, ArrowDownUp } from 'lucide-react'
import { ARC, ARC_CHAIN_ID, ARC_ERC20_APPROVE_GAS, ARC_EXPLORER, ARC_MAX_APPROVAL, ARC_SWAP_GAS, arcPublicClient } from '@/lib/contracts-arc'
import { setWalletRpcPaused } from '@/lib/wallet-rpc-pause'
import { buildEveV4Swap, quoteEveV4ExactIn, quoteEveV4PricedInUsdc, readEveV4Pool, type EveV4PoolInfo } from '@/lib/arc-v4-swap'
import {
  arcSwapConfigured,
  arcSwapSpender,
  buildArcBuy,
  buildArcSell,
  buildV3ExactIn,
  findArcPoolFee,
  formatUsdc,
  minOutFromSlippage,
  parseUsdc,
  quoteArcBuy,
  quoteArcSell,
  quoteV3ExactIn,
  withRecipient,
} from '@/lib/arc-swap'
import { quoteDecimalsForToken, quotePolicy, quoteSymbolForQuote, rwaAssetByQuote, usdToQuoteHuman } from '@/lib/arc-rwa-assets'
import { fetchQuoteUsdSpot, spotQuoteToUsd } from '@/lib/quote-usd-spot'
import { formatToken, parseToken } from '@/lib/token-format'
import { getIncomingReferralCode } from '@/lib/crucible'
import { feePairLabel } from '@/lib/eve-fee-split'
import { fmtPrice, fmtUsd, tileGradient } from '@/lib/ui-format'
import { cdnImage } from '@/lib/cdn-image'
import { WalletButton } from '@/components/WalletButton'
import { useArcErc20Balance } from '@/lib/use-arc-erc20-balance'

const SLIPPAGE_BPS = 500 // 5% — thin Instant single-sided ranges
const BUY_PRESETS = [25, 100, 250, 500]
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

/** Quote amounts (cirBTC 8dp especially) need more than 4 dp so $10 does not print as 0. */
function fmtQuoteAmt(v: bigint, decimals: number): string {
  const n = Number(formatUnits(v, decimals))
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n < 1e-8) return n.toExponential(2)
  if (n < 0.01) return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 8) })
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 6) })
}

function parseQuoteAmt(v: string, decimals: number): bigint {
  try {
    const s = String(v || '0').trim()
    if (!s || Number(s) <= 0) return 0n
    return parseUnits(s, decimals)
  } catch {
    return 0n
  }
}

function quoteMarkSrc(quote: Address | undefined): string | null {
  const id = rwaAssetByQuote(quote)?.id
  if (id === 'cirbtc') return '/marks/cirbtc.svg'
  if (id === 'xaum') return '/marks/xaum.svg'
  if (id === 'usyc') return '/marks/usyc.png'
  if (id === 'buidl') return '/marks/buidl.png'
  if (id === 'crcl') return '/marks/crcl.svg'
  return null
}

function quoteHumanToUsd(
  human: number,
  quote: Address | undefined,
  spotPx: number | null,
): number | null {
  if (!(human > 0) || !Number.isFinite(human)) return null
  const p = quotePolicy(rwaAssetByQuote(quote))
  if (p.usd === 'peg') return human
  if (p.usd === 'spot') {
    const usd = spotQuoteToUsd(human, spotPx)
    return usd > 0 ? usd : null
  }
  return null
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
  const { writeContractAsync } = useWriteContract()

  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [estOut, setEstOut] = useState<bigint | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()
  const [v4Pool, setV4Pool] = useState<EveV4PoolInfo | null>(null)
  const [v4Ready, setV4Ready] = useState(false)
  const [spotPx, setSpotPx] = useState<number | null>(null)
  const submitLock = useRef(false)

  const { isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash })
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const isV4 = Boolean(v4Pool)
  const v4RouterOn = Boolean(
    ARC.INSTANT_V4_ROUTER && ARC.INSTANT_V4_ROUTER !== '0x0000000000000000000000000000000000000000',
  )
  const swapOn = isV4 ? v4RouterOn : v4Ready ? arcSwapConfigured() : v4RouterOn || arcSwapConfigured()
  const spender = isV4 ? ARC.INSTANT_V4_ROUTER : arcSwapSpender(mode)
  const quoteToken: Address = v4Pool?.quote ?? ARC.USDC
  const quoteSym = quoteSymbolForQuote(quoteToken)
  const quoteDec = quoteDecimalsForToken(quoteToken)
  const quoteAsset = rwaAssetByQuote(quoteToken)
  const spotPolicy = quotePolicy(quoteAsset)
  const spotUsd = spotPolicy.usd === 'spot'
  const spotPair = spotPolicy.usdSpot
  /** Gold and BTC pools trade in the quote token. The pad prices those in USDC. */
  const payUsdc = Boolean(isV4 && spotPolicy.payUsdcSwap && quoteSym !== 'USDC')

  useEffect(() => {
    let cancelled = false
    setV4Pool(null)
    setV4Ready(false)
    void readEveV4Pool(token, arcPublicClient())
      .then((info) => {
        if (!cancelled) {
          setV4Pool(info)
          setV4Ready(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setV4Pool(null)
          setV4Ready(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!spotUsd || !spotPair) {
      setSpotPx(null)
      return
    }
    let cancelled = false
    void fetchQuoteUsdSpot(spotPair).then((px) => {
      if (!cancelled) setSpotPx(px)
    })
    return () => {
      cancelled = true
    }
  }, [spotUsd, spotPair])
  const refCode = mode === 'buy' ? getIncomingReferralCode() : ''
  const { tile, mono } = tileGradient(token)
  const initial = (symbol || '?').charAt(0).toUpperCase()

  const quoteQ = useArcErc20Balance(quoteToken, address)
  const usdcQ = useArcErc20Balance(payUsdc ? ARC.USDC : undefined, address)
  const tokQ = useArcErc20Balance(token, address)
  const quoteBal = quoteQ.data
  const usdcBal = usdcQ.data
  const tokenBal = tokQ.data
  const refetchQuote = quoteQ.refetch
  const refetchUsdc = usdcQ.refetch
  const refetchTok = tokQ.refetch
  const payBalPending = mode === 'buy' ? (payUsdc ? usdcQ.isPending : quoteQ.isPending) : tokQ.isPending

  const { data: tokenDecimals } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'decimals',
    chainId: ARC_CHAIN_ID,
    query: { staleTime: 3_600_000 },
  })
  const tokDec = Number(tokenDecimals ?? ARC.TOKEN_DECIMALS) || ARC.TOKEN_DECIMALS

  const approveSpender: Address = payUsdc && mode === 'buy' ? ARC.UNI_ROUTER : spender
  const approveToken: Address = mode === 'buy' ? (payUsdc ? ARC.USDC : quoteToken) : token
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approveToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, approveSpender] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address },
  })

  useEffect(() => {
    return () => setWalletRpcPaused(false)
  }, [])

  useEffect(() => {
    if (!mined) return
    setWalletRpcPaused(false)
    setStatusMsg('Confirmed ✓')
    setBusy(false)
    submitLock.current = false
    setAmount('')
    setEstOut(null)
    void refetchQuote()
    void refetchUsdc()
    void refetchTok()
    void refetchAllowance()
    onTraded?.()
  }, [mined, onTraded, refetchQuote, refetchUsdc, refetchTok, refetchAllowance])

  useEffect(() => {
    if (busy || !amount || Number(amount) <= 0 || !swapOn) {
      if (!amount || Number(amount) <= 0 || !swapOn) {
        setEstOut(null)
        setError(null)
      }
      setQuoting(false)
      return
    }
    if (!v4Ready) {
      setQuoting(true)
      return
    }
    let cancelled = false
    const run = async () => {
      setEstOut(null)
      setQuoting(true)
      try {
        const ref = mode === 'buy' ? getIncomingReferralCode() : ''
        if (isV4 && v4Pool) {
          const inAmt = payUsdc
            ? mode === 'buy'
              ? parseUsdc(amount)
              : parseToken(amount, tokDec)
            : mode === 'buy'
              ? parseQuoteAmt(amount, quoteDec)
              : parseToken(amount, tokDec)
          if (inAmt <= 0n) {
            if (!cancelled) {
              setEstOut(null)
              setError(null)
            }
            return
          }
          const zeroForOne = mode === 'buy' ? !v4Pool.tokenIsCurrency0 : v4Pool.tokenIsCurrency0
          // Public RPC only. A wallet eth_call while Rabby is open blanks the Sign screen.
          let local: bigint | null = null
          try {
            if (payUsdc) {
              const priced = await quoteEveV4PricedInUsdc(v4Pool, mode, inAmt, arcPublicClient())
              local = priced?.out ?? null
            } else {
              local = await quoteEveV4ExactIn(v4Pool, inAmt, zeroForOne, arcPublicClient())
            }
          } catch {
            local = null
          }
          if (cancelled) return
          if (local != null && local > 0n) {
            setEstOut(local)
            setError(null)
            return
          }
        }
        if (!isV4) {
          const local =
            mode === 'buy'
              ? await quoteArcBuy(token, parseUsdc(amount), ref)
              : await quoteArcSell(token, parseToken(amount, tokDec))
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
  }, [amount, mode, token, swapOn, busy, tokDec, isV4, v4Pool, v4Ready, quoteDec, payUsdc])

  const needApprove = (() => {
    if (!amount || Number(amount) <= 0) return false
    const need =
      mode === 'buy'
        ? payUsdc
          ? parseUsdc(amount)
          : isV4
            ? parseQuoteAmt(amount, quoteDec)
            : parseUsdc(amount)
        : parseToken(amount, tokDec)
    return (allowance as bigint | undefined ?? 0n) < need
  })()

  const onSubmit = async () => {
    if (!address || !amount || Number(amount) <= 0) return
    if (submitLock.current || busy) return
    submitLock.current = true
    setError(null)
    setBusy(true)
    setStatusMsg('')
    setWalletRpcPaused(true)
    try {
      if (needApprove) {
        setStatusMsg(mode === 'buy' ? `Approve ${payUsdc ? 'USDC' : quoteSym}…` : `Approve ${symbol}…`)
        await writeContractAsync({
          address: approveToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [approveSpender, ARC_MAX_APPROVAL],
          chainId: ARC_CHAIN_ID,
          gas: ARC_ERC20_APPROVE_GAS,
        })
        void refetchAllowance()
        if (estOut == null || estOut <= 0n) {
          setStatusMsg('Approved. Waiting for a quote…')
          setBusy(false)
          submitLock.current = false
          setWalletRpcPaused(false)
          return
        }
      }
      if (estOut == null || estOut <= 0n) {
        throw new Error('No quote yet. Wait a moment or try a smaller amount.')
      }
      const quoted = estOut
      const pub = arcPublicClient()
      const send = async (
        call: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; chainId: number },
        gas: bigint = ARC_SWAP_GAS,
      ) => {
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas,
        })
        const receipt = await pub.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction failed')
        return hash
      }
      const balanceOf = async (erc20: Address) =>
        pub.readContract({
          address: erc20,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        })
      if (isV4 && v4Pool && payUsdc) {
        const priced = await quoteEveV4PricedInUsdc(
          v4Pool,
          mode,
          mode === 'buy' ? parseUsdc(amount) : parseToken(amount, tokDec),
          pub,
        )
        if (!priced || priced.out <= 0n || priced.quoteAmount <= 0n) {
          throw new Error('No USDC quote for this size. Try a smaller amount.')
        }
        if (mode === 'buy') {
          const usdcIn = parseUsdc(amount)
          setStatusMsg('Confirm USDC swap…')
          const before = await balanceOf(v4Pool.quote)
          await send(
            buildV3ExactIn({
              tokenIn: ARC.USDC,
              tokenOut: v4Pool.quote,
              fee: priced.usdcFee,
              amountIn: usdcIn,
              minOut: minOutFromSlippage(priced.quoteAmount, SLIPPAGE_BPS),
              recipient: address,
            }),
          )
          const got = (await balanceOf(v4Pool.quote)) - before
          if (got <= 0n) throw new Error('USDC swap returned no quote token.')
          const allowanceNow = await pub.readContract({
            address: v4Pool.quote,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, ARC.INSTANT_V4_ROUTER],
          })
          if (allowanceNow < got) {
            setStatusMsg(`Approve ${quoteSym}…`)
            await send(
              {
                address: v4Pool.quote,
                abi: erc20Abi,
                functionName: 'approve',
                args: [ARC.INSTANT_V4_ROUTER, ARC_MAX_APPROVAL],
                chainId: ARC_CHAIN_ID,
              },
              ARC_ERC20_APPROVE_GAS,
            )
          }
          setStatusMsg('Confirm buy…')
          const tokenOut = await quoteEveV4ExactIn(v4Pool, got, !v4Pool.tokenIsCurrency0, pub)
          const hash = await send(
            buildEveV4Swap({
              key: v4Pool.key,
              zeroForOne: !v4Pool.tokenIsCurrency0,
              amountIn: got,
              minOut: minOutFromSlippage(tokenOut && tokenOut > 0n ? tokenOut : priced.out, SLIPPAGE_BPS),
              recipient: address,
            }),
          )
          setWalletRpcPaused(false)
          setTxHash(hash)
          setStatusMsg('Confirming…')
        } else {
          const inAmt = parseToken(amount, tokDec)
          setStatusMsg('Confirm sell…')
          const before = await balanceOf(v4Pool.quote)
          await send(
            buildEveV4Swap({
              key: v4Pool.key,
              zeroForOne: v4Pool.tokenIsCurrency0,
              amountIn: inAmt,
              minOut: minOutFromSlippage(priced.quoteAmount, SLIPPAGE_BPS),
              recipient: address,
            }),
          )
          const got = (await balanceOf(v4Pool.quote)) - before
          if (got <= 0n) throw new Error(`Sell returned no ${quoteSym}.`)
          const hop = await quoteV3ExactIn(v4Pool.quote, ARC.USDC, got, pub)
          if (!hop) throw new Error(`Could not quote ${quoteSym} to USDC. ${quoteSym} is in your wallet.`)
          const allowanceNow = await pub.readContract({
            address: v4Pool.quote,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, ARC.UNI_ROUTER],
          })
          if (allowanceNow < got) {
            setStatusMsg(`Approve ${quoteSym}…`)
            await send(
              {
                address: v4Pool.quote,
                abi: erc20Abi,
                functionName: 'approve',
                args: [ARC.UNI_ROUTER, ARC_MAX_APPROVAL],
                chainId: ARC_CHAIN_ID,
              },
              ARC_ERC20_APPROVE_GAS,
            )
          }
          setStatusMsg('Confirm USDC swap…')
          const hash = await send(
            buildV3ExactIn({
              tokenIn: v4Pool.quote,
              tokenOut: ARC.USDC,
              fee: hop.fee,
              amountIn: got,
              minOut: minOutFromSlippage(hop.amountOut, SLIPPAGE_BPS),
              recipient: address,
            }),
          )
          setWalletRpcPaused(false)
          setTxHash(hash)
          setStatusMsg('Confirming…')
        }
      } else if (isV4 && v4Pool) {
        const inAmt = mode === 'buy' ? parseQuoteAmt(amount, quoteDec) : parseToken(amount, tokDec)
        if (inAmt <= 0n) throw new Error('Invalid amount.')
        const minOut = minOutFromSlippage(quoted, SLIPPAGE_BPS)
        if (minOut <= 0n) throw new Error('Quote too small for this size.')
        const zeroForOne = mode === 'buy' ? !v4Pool.tokenIsCurrency0 : v4Pool.tokenIsCurrency0
        setStatusMsg('Confirm in wallet…')
        const call = buildEveV4Swap({
          key: v4Pool.key,
          zeroForOne,
          amountIn: inAmt,
          minOut,
          recipient: address,
        })
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_SWAP_GAS,
        })
        setWalletRpcPaused(false)
        setTxHash(hash)
        setStatusMsg('Confirming…')
      } else if (mode === 'buy') {
        const inAmt = parseUsdc(amount)
        const minOut = minOutFromSlippage(quoted, SLIPPAGE_BPS)
        setStatusMsg('Confirm in wallet…')
        // Cached from the public quote. Do not pass the wallet client: those
        // eth_calls land in Rabby while the sign popup is opening and blank it.
        const poolFee = (await findArcPoolFee(token)) ?? undefined
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
        setWalletRpcPaused(false)
        setTxHash(hash)
        setStatusMsg('Confirming…')
      } else {
        const inAmt = parseToken(amount, tokDec)
        const minOut = minOutFromSlippage(quoted, SLIPPAGE_BPS)
        setStatusMsg('Confirm in wallet…')
        const poolFee = (await findArcPoolFee(token)) ?? undefined
        const call = buildArcSell(token, inAmt, minOut, address, poolFee)
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_SWAP_GAS,
        })
        setWalletRpcPaused(false)
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
      setWalletRpcPaused(false)
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
  const payBal = mode === 'buy'
    ? ((payUsdc ? usdcBal : quoteBal) as bigint | undefined) ?? 0n
    : ((tokenBal as bigint | undefined) ?? 0n)
  const payBalLabel = payBalPending
    ? '…'
    : mode === 'buy'
      ? payUsdc || quoteSym === 'USDC'
        ? formatUsdc(payBal)
        : fmtQuoteAmt(payBal, quoteDec)
      : fmtTok(payBal, tokDec)
  const receiveAmt =
    quoting && amtNum > 0
      ? '…'
      : estOut == null
        ? '0'
        : mode === 'buy'
          ? fmtTok(estOut, tokDec)
          : payUsdc || !isV4
            ? formatUsdc(estOut)
            : fmtQuoteAmt(estOut, quoteDec)
  const receiveSym = mode === 'buy' ? symbol : payUsdc || !isV4 ? 'USDC' : quoteSym
  const receiveUsd =
    mode === 'sell' && !payUsdc && estOut != null && estOut > 0n
      ? quoteHumanToUsd(Number(formatUnits(estOut, isV4 ? quoteDec : 6)), isV4 ? quoteToken : ARC.USDC, spotPx)
      : mode === 'buy' && !payUsdc && amtNum > 0
        ? quoteHumanToUsd(amtNum, isV4 ? quoteToken : ARC.USDC, spotPx)
        : null
  const TokenChip = ({ kind }: { kind: 'quote' | 'token' }) =>
    kind === 'quote' ? (
      quoteSym === 'USDC' || payUsdc ? (
        <span className="inline-flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-full bg-[#111318] border border-white/10">
          <UsdcMark />
          <span className="text-[15px] font-semibold">USDC</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-full bg-[#111318] border border-white/10">
          {quoteMarkSrc(quoteToken) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={quoteMarkSrc(quoteToken) || ''} alt="" className="w-7 h-7 rounded-full object-cover" />
          ) : (
            <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-white/10">
              {quoteSym.charAt(0)}
            </span>
          )}
          <span className="text-[15px] font-semibold">{quoteSym}</span>
        </span>
      )
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

  const buyFeeBps = isV4 ? v4Pool?.buyFeeBps || v4Pool?.feeBps || 100 : 100
  const sellFeeBps = isV4 ? v4Pool?.sellFeeBps || v4Pool?.feeBps || 100 : 100
  const feeBps = mode === 'sell' ? sellFeeBps : buyFeeBps
  const feeLabel = isV4 ? feePairLabel(buyFeeBps, sellFeeBps) : feeBps === 100 ? '1% fee' : `${(feeBps / 100).toFixed(1)}% fee`
  const inUsd = payUsdc && mode === 'buy'
    ? amtNum > 0 ? amtNum : null
    : quoteHumanToUsd(amtNum, isV4 ? quoteToken : ARC.USDC, spotPx)
  const outUsd =
    estOut != null && estOut > 0n
      ? mode === 'buy'
        ? null
        : payUsdc
          ? Number(formatUnits(estOut, 6))
          : quoteHumanToUsd(Number(formatUnits(estOut, isV4 ? quoteDec : 6)), isV4 ? quoteToken : ARC.USDC, spotPx)
      : null
  const feeUsd =
    mode === 'buy'
      ? (inUsd ?? 0) * (feeBps / 10_000)
      : outUsd != null
        ? outUsd * (feeBps / Math.max(1, 10_000 - feeBps))
        : 0
  const pricePer =
    amtNum > 0 && estOut != null && estOut > 0n
      ? mode === 'buy'
        ? inUsd != null
          ? inUsd / Number(formatUnits(estOut, tokDec))
          : null
        : outUsd != null
          ? outUsd / amtNum
          : null
      : null

  return (
    <div className="rounded-2xl bg-s1 p-4 shadow-[0_0_0_1px_rgb(255_255_255_/_0.08)]">
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-full bg-s2 p-1">
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
            className={`h-9 rounded-full text-sm font-medium capitalize transition-colors duration-150 ${
              mode === s
                ? s === 'buy'
                  ? 'bg-up text-accent-fg'
                  : 'bg-down text-white'
                : 'text-t3 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-xs text-t3">
            {mode === 'buy' ? `You pay · ${payUsdc || !isV4 || quoteSym === 'USDC' ? 'USDC' : quoteSym}` : `You sell · $${symbol}`}
          </label>
          <div className="mt-2 flex items-center gap-2 h-12 rounded-xl bg-s2 border border-hair px-3">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              placeholder="0"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-lg tabular-nums placeholder:text-t3"
            />
            <TokenChip kind={mode === 'buy' ? 'quote' : 'token'} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-t3">
            <span>Wallet {payBalLabel}{mode === 'buy' && isV4 && !payUsdc && quoteSym !== 'USDC' ? ` ${quoteSym}` : ''}</span>
            <button
              type="button"
              disabled={payBalPending || payBal === 0n}
              onClick={() => {
                if (payBalPending || payBal <= 0n) return
                setAmount(
                  mode === 'buy'
                    ? payUsdc || quoteSym === 'USDC'
                      ? formatUsdc(payBal).replace(/,/g, '')
                      : formatUnits(payBal, quoteDec)
                    : formatToken(payBal, tokDec),
                )
              }}
              className="text-white/80 hover:text-white disabled:opacity-40"
            >
              Max
            </button>
          </div>
          {mode === 'buy' && isV4 && spotUsd && !payUsdc && amtNum > 0 && spotPx ? (
            <p className="mt-1 mb-0 text-[11px] text-t3">≈ {fmtUsd(spotQuoteToUsd(amtNum, spotPx))}</p>
          ) : null}
          {mode === 'buy' ? (
            <div className="mt-2 flex gap-1.5">
              {BUY_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={!payUsdc && spotUsd && !(spotPx && spotPx > 0)}
                  onClick={() => {
                    if (payUsdc) {
                      setAmount(String(v))
                    } else if (spotUsd) {
                      if (!spotPx) return
                      setAmount(usdToQuoteHuman(v, spotPx, quoteDec))
                    } else {
                      setAmount(String(v))
                    }
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-t3 bg-s2 hover:text-white disabled:opacity-40"
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
              <span className="text-sm text-t3">{receiveSym}</span>
            </div>
            {mode === 'sell' && receiveUsd != null ? (
              <div className="mt-0.5 text-[12px] text-t3 tabular-nums">≈ {fmtUsd(receiveUsd)}</div>
            ) : null}
          </div>

          <div className="mt-3 flex justify-between text-xs text-t3">
            <span>Price</span>
            <span className="tabular-nums">
              {pricePer != null ? `${fmtPrice(pricePer)} / token` : '—'}
            </span>
          </div>
          <div className="mt-1 flex justify-between text-xs text-t3">
            <span>{feeLabel}</span>
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
                estOut == null
              }
              onClick={() => void onSubmit()}
              className={`mt-5 w-full h-11 rounded-full text-sm font-semibold tracking-tightish disabled:opacity-40 transition-colors ${
                mode === 'buy' ? 'bg-up text-accent-fg hover:brightness-110' : 'bg-down text-white hover:brightness-110'
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
