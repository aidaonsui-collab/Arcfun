'use client'

/**
 * Arc OTC desk — maker/taker book (Base / ARB USDC → Arc USDC).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from 'wagmi'
import { isAddress, type Address } from 'viem'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  ROBIN_OTC_LIQUIDITY,
  ARC_USDC,
  robinOtcEnabled,
  PAYMENT_ABI,
  LIQUIDITY_ABI,
  ERC20_MIN_ABI,
  fetchOtcOffers,
  fetchOtcFeeBps,
  quoteFill,
  premiumLabel,
  parseUsdc6,
  formatUsdc6,
  livePaymentChains,
  defaultPaymentChainId,
  paymentSpokesLabel,
  sumOfferDepth,
  rememberLocalFill,
  fetchOtcDeskStats,
  OTC_DEFAULT_FEE_BPS,
  OTC_ROBIN_FEE_BPS,
  OTC_RESERVE_TTL_SEC,
  encodeEventTopics,
  type OtcOffer,
  type OtcPaymentChain,
  type OtcPaymentChainId,
  type OtcDeskStats,
} from '@/lib/bridge/robin-otc'
import type { Hex } from 'viem'
type Mode = 'buy' | 'make'

export function InstantOtcPanel() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const paymentOptions = useMemo(() => livePaymentChains(), [])
  const [payId, setPayId] = useState<OtcPaymentChainId>(() => defaultPaymentChainId())
  const payChain: OtcPaymentChain | undefined =
    paymentOptions.find((c) => c.id === payId) ?? paymentOptions[0]

  const payClient = usePublicClient({ chainId: payChain?.chainId })

  const [mode, setMode] = useState<Mode>('buy')
  const [offers, setOffers] = useState<OtcOffer[]>([])
  const [feeBps, setFeeBps] = useState(OTC_DEFAULT_FEE_BPS)
  const [robinFeeBps, setRobinFeeBps] = useState(OTC_ROBIN_FEE_BPS)
  const [robinEligible, setRobinEligible] = useState(false)
  const [robinSig, setRobinSig] = useState<`0x${string}` | null>(null)
  const [robinDeadline, setRobinDeadline] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [selected, setSelected] = useState<OtcOffer | null>(null)
  const [fillOpen, setFillOpen] = useState(false)
  const [destAmt, setDestAmt] = useState('')
  const [destRecipient, setDestRecipient] = useState('')
  /** When false, Arc USDC always goes to the connected wallet. */
  const [useDifferentRecipient, setUseDifferentRecipient] = useState(false)
  /** Required when sending to a non-connected address. */
  const [recipientConfirmed, setRecipientConfirmed] = useState(false)
  const [premiumPct, setPremiumPct] = useState('5')
  const [makeAmt, setMakeAmt] = useState('')
  const [sellerPayment, setSellerPayment] = useState('')
  const [busy, setBusy] = useState(false)
  const [deskStats, setDeskStats] = useState<OtcDeskStats>({ settledTrades: 0, volumeUsdc: 0n })

  const enabled = robinOtcEnabled()
  const openDepth = useMemo(() => sumOfferDepth(offers), [offers])
  /** Effective platform fee for this wallet (discount voucher applied silently when present). */
  const effectiveFeeBps = robinEligible && robinSig && robinDeadline > Date.now() / 1000
    ? robinFeeBps
    : feeBps
  const bestAllIn = useMemo(() => {
    if (!offers[0]) return undefined
    return allInMultiplierSafe(offers[0].premiumBps, feeBps)
  }, [offers, feeBps])

  const effectiveRecipient = useDifferentRecipient
    ? destRecipient.trim()
    : address || destRecipient.trim()
  const recipientOk = isAddress(effectiveRecipient)
  const recipientAddr = recipientOk ? (effectiveRecipient as Address) : null
  const recipientIsDifferent =
    !!address &&
    !!recipientAddr &&
    recipientAddr.toLowerCase() !== address.toLowerCase()
  const recipientReady =
    recipientOk && (!useDifferentRecipient || !recipientIsDifferent || recipientConfirmed)

  useEffect(() => {
    if (!payChain && paymentOptions[0]) setPayId(paymentOptions[0].id)
  }, [payChain, paymentOptions])

  const refreshRobin = useCallback(async () => {
    if (!address || !payChain) {
      setRobinEligible(false)
      setRobinSig(null)
      return
    }
    try {
      const res = await fetch(
        `/api/bridge/otc-voucher?address=${address}&chainId=${payChain.chainId}`,
      )
      const data = (await res.json()) as {
        eligible?: boolean
        feeBps?: number
        robinFeeBps?: number
        signature?: string
        deadline?: number
      }
      setRobinEligible(!!data.eligible && !!data.signature)
      setRobinFeeBps(data.robinFeeBps ?? OTC_ROBIN_FEE_BPS)
      setRobinSig(data.signature && data.eligible ? (data.signature as `0x${string}`) : null)
      setRobinDeadline(data.deadline ?? 0)
    } catch {
      setRobinEligible(false)
      setRobinSig(null)
    }
  }, [address, payChain])

  useEffect(() => {
    void refreshRobin()
  }, [refreshRobin])

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setErr(null)
    try {
      const [list, fee, stats] = await Promise.all([
        fetchOtcOffers(),
        fetchOtcFeeBps(),
        fetchOtcDeskStats(),
      ])
      setOffers(list)
      setFeeBps(fee)
      setDeskStats(stats)
      setSelected((prev) => {
        if (!prev) return prev
        return list.find((o) => o.offerId === prev.offerId) ?? null
      })
      void refreshRobin()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [enabled, refreshRobin])

  // Poll faster when any offer has pending fills so tiles clear after settle.
  const hasAnyPending = offers.some((o) => (o.pendingReserved ?? 0n) > 0n)
  useEffect(() => {
    void refresh()
    const ms = hasAnyPending ? 6_000 : 15_000
    const t = setInterval(() => void refresh(), ms)
    return () => clearInterval(t)
  }, [refresh, hasAnyPending])

  useEffect(() => {
    if (address && !sellerPayment) setSellerPayment(address)
  }, [address, sellerPayment])

  // Lock body scroll while modal open
  useEffect(() => {
    if (!fillOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [fillOpen])

  useEffect(() => {
    if (!fillOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        setFillOpen(false)
        setDestAmt('')
        setStatus(null)
        setErr(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fillOpen, busy])

  const quote = useMemo(() => {
    if (!selected || !destAmt) return null
    try {
      const dest = parseUsdc6(destAmt)
      const cap = selected.available ?? selected.remaining
      if (dest <= 0n || dest > cap) return null
      return quoteFill(dest, selected.premiumBps, effectiveFeeBps)
    } catch {
      return null
    }
  }, [selected, destAmt, effectiveFeeBps])

  const ensurePayChain = async () => {
    if (!payChain) throw new Error('No payment chain configured')
    if (chainId !== payChain.chainId) await switchChainAsync({ chainId: payChain.chainId })
  }
  const ensureArc = async () => {
    if (chainId !== ARC_CHAIN_ID) await switchChainAsync({ chainId: ARC_CHAIN_ID })
  }

  const openFill = (o: OtcOffer) => {
    const available = o.available ?? o.remaining
    if (available <= 0n) {
      setErr('This offer is fully reserved. Wait for settlement or try another.')
      return
    }
    setSelected(o)
    setDestAmt('')
    setDestRecipient(address || '')
    setUseDifferentRecipient(false)
    setRecipientConfirmed(false)
    setErr(null)
    setStatus(null)
    setFillOpen(true)
  }

  const closeFill = () => {
    if (busy) return
    setFillOpen(false)
    setDestAmt('')
    setUseDifferentRecipient(false)
    setRecipientConfirmed(false)
    setStatus(null)
    setErr(null)
  }

  const makeArcPublicClient = async () => {
    const { createPublicClient, http } = await import('viem')
    const rpc = process.env.NEXT_PUBLIC_ARC_RPC || process.env.ARC_RPC || ''
    return createPublicClient({
      chain: {
        id: ARC_CHAIN_ID,
        name: 'Arc',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      },
      transport: http(rpc),
    })
  }

  const setMax = () => {
    if (!selected) return
    setDestAmt(formatUsdc6(selected.available ?? selected.remaining))
  }

  const onFill = async () => {
    if (!address || !selected || !quote || !payChain || !payClient || !recipientAddr) return
    if (!recipientReady) {
      setErr('Confirm the Arc recipient address before filling.')
      return
    }
    setErr(null)
    setStatus(null)
    setBusy(true)
    let reservationId: Hex | null = null
    let arcPub: Awaited<ReturnType<typeof makeArcPublicClient>> | null = null
    try {
      const dest = parseUsdc6(destAmt)
      const cap = selected.available ?? selected.remaining
      if (dest > cap) throw new Error('Amount exceeds free inventory on this offer')

      // 1) Hard-reserve free Arc inventory so concurrent fills cannot over-subscribe.
      setStatus('Switch to Arc & reserve inventory…')
      await ensureArc()
      arcPub = await makeArcPublicClient()
      setStatus('Reserving Arc USDC inventory…')
      const reserveTx = await writeContractAsync({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'reserve',
        args: [selected.offerId, dest, OTC_RESERVE_TTL_SEC],
        chainId: ARC_CHAIN_ID,
        gas: 250_000n,
      })
      const reserveReceipt = await arcPub.waitForTransactionReceipt({ hash: reserveTx })
      const reservedTopics = encodeEventTopics({
        abi: LIQUIDITY_ABI,
        eventName: 'Reserved',
      })
      const reservedTopic0 = (reservedTopics[0] as string | undefined)?.toLowerCase()
      const reservedLog = reserveReceipt.logs.find(
        (l) =>
          l.topics[0]?.toLowerCase() === reservedTopic0 &&
          l.address.toLowerCase() === ROBIN_OTC_LIQUIDITY.toLowerCase(),
      )
      if (!reservedLog?.topics[1]) {
        throw new Error('Reserve succeeded but reservation id missing from logs')
      }
      reservationId = reservedLog.topics[1] as Hex

      // Optimistic free inventory drop (hard reserve already on-chain).
      const offerKey = selected.offerId
      setOffers((prev) =>
        prev.map((o) => {
          if (o.offerId.toLowerCase() !== offerKey.toLowerCase()) return o
          const remaining = o.remaining > dest ? o.remaining - dest : 0n
          const pending = (o.pendingReserved ?? 0n) + dest
          return {
            ...o,
            remaining,
            available: remaining,
            pendingReserved: pending,
            hasPending: pending > 0n,
          }
        }),
      )

      // 2) Pay on Base/ARB with reservationId bound to the fill.
      setStatus(`Switch to ${payChain.name}…`)
      await ensurePayChain()

      setStatus(`Approve USDC on ${payChain.name}…`)
      const allowance = (await payClient.readContract({
        address: payChain.usdc,
        abi: ERC20_MIN_ABI,
        functionName: 'allowance',
        args: [address, payChain.payment],
      })) as bigint
      if (allowance < quote.total) {
        const tx = await writeContractAsync({
          address: payChain.usdc,
          abi: ERC20_MIN_ABI,
          functionName: 'approve',
          args: [payChain.payment, quote.total],
          chainId: payChain.chainId,
          gas: 100_000n,
        })
        await payClient.waitForTransactionReceipt({ hash: tx })
      }

      setStatus(`Escrowing on ${payChain.name}…`)
      const useRobin =
        robinEligible &&
        robinSig &&
        robinDeadline > Math.floor(Date.now() / 1000)
      const fillTx = useRobin
        ? await writeContractAsync({
            address: payChain.payment,
            abi: PAYMENT_ABI,
            functionName: 'fillOfferRobin',
            args: [
              selected.offerId,
              dest,
              recipientAddr,
              selected.sellerPayment,
              selected.premiumBps,
              reservationId,
              BigInt(robinDeadline),
              robinSig,
            ],
            chainId: payChain.chainId,
            gas: 350_000n,
          })
        : await writeContractAsync({
            address: payChain.payment,
            abi: PAYMENT_ABI,
            functionName: 'fillOffer',
            args: [
              selected.offerId,
              dest,
              recipientAddr,
              selected.sellerPayment,
              selected.premiumBps,
              reservationId,
            ],
            chainId: payChain.chainId,
            gas: 300_000n,
          })
      const receipt = await payClient.waitForTransactionReceipt({ hash: fillTx })
      const fillTopics = encodeEventTopics({
        abi: PAYMENT_ABI,
        eventName: 'FillCreated',
      })
      const fillTopic0 = (fillTopics[0] as string | undefined)?.toLowerCase()
      const fillLog = receipt.logs.find(
        (l) =>
          l.topics[0]?.toLowerCase() === fillTopic0 &&
          l.address.toLowerCase() === payChain.payment.toLowerCase(),
      )
      if (fillLog?.topics[1]) {
        rememberLocalFill(fillLog.topics[1] as `0x${string}`, payChain.id)
      }
      reservationId = null // bound to fill; do not release

      setStatus(
        `Escrowed. Keeper delivers Arc USDC to ${short(recipientAddr)}. Offer shows pending until settled.`,
      )
      setDestAmt('')
      setFillOpen(false)
      setUseDifferentRecipient(false)
      setRecipientConfirmed(false)
      await refresh()
      window.setTimeout(() => void refresh(), 2_500)
      window.setTimeout(() => void refresh(), 8_000)
    } catch (e) {
      // If we reserved but payment fill failed, release free inventory back to the book.
      if (reservationId) {
        try {
          setStatus('Fill failed — releasing Arc reservation…')
          await ensureArc()
          if (!arcPub) arcPub = await makeArcPublicClient()
          const releaseTx = await writeContractAsync({
            address: ROBIN_OTC_LIQUIDITY,
            abi: LIQUIDITY_ABI,
            functionName: 'releaseReservation',
            args: [reservationId],
            chainId: ARC_CHAIN_ID,
            gas: 200_000n,
          })
          await arcPub.waitForTransactionReceipt({ hash: releaseTx })
          setStatus(null)
        } catch {
          /* reservation auto-expires; surface original error */
        }
      }
      setErr(e instanceof Error ? e.message : String(e))
      setStatus(null)
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  const onCreateOffer = async () => {
    if (!address) return
    setErr(null)
    setStatus(null)
    setBusy(true)
    try {
      await ensureArc()
      const amount = parseUsdc6(makeAmt)
      if (amount <= 0n) throw new Error('Enter amount')
      const pct = Number(premiumPct)
      if (!Number.isFinite(pct) || pct < 0 || pct > 10_000) throw new Error('Premium 0–10000%')
      const premiumBps = Math.round(pct * 100)
      const payTo = (sellerPayment || address) as Address

      setStatus('Approve Arc USDC…')
      const arcPub = await makeArcPublicClient()
      const allowance = (await arcPub.readContract({
        address: ARC_USDC,
        abi: ERC20_MIN_ABI,
        functionName: 'allowance',
        args: [address, ROBIN_OTC_LIQUIDITY],
      })) as bigint
      if (allowance < amount) {
        const tx = await writeContractAsync({
          address: ARC_USDC,
          abi: ERC20_MIN_ABI,
          functionName: 'approve',
          args: [ROBIN_OTC_LIQUIDITY, amount],
          chainId: ARC_CHAIN_ID,
          gas: 100_000n,
        })
        await arcPub.waitForTransactionReceipt({ hash: tx })
      }

      setStatus('Creating offer…')
      const tx = await writeContractAsync({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'createOffer',
        args: [premiumBps, payTo, amount],
        chainId: ARC_CHAIN_ID,
        gas: 300_000n,
      })
      await arcPub.waitForTransactionReceipt({ hash: tx })
      setStatus('Offer live.')
      setMakeAmt('')
      setMode('buy')
      void refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  const ctaLabel = (() => {
    if (!isConnected) return 'Connect wallet'
    if (busy) return 'Confirm in wallet…'
    if (!destAmt || !quote) return 'Enter an amount'
    if (!recipientOk) return 'Enter a valid Arc recipient'
    if (useDifferentRecipient && recipientIsDifferent && !recipientConfirmed) {
      return 'Confirm recipient address'
    }
    if (!payChain) return 'Select pay chain'
    if (chainId !== ARC_CHAIN_ID && chainId !== payChain.chainId) {
      return 'Reserve on Arc, then pay'
    }
    return `Confirm · reserve + pay ${payChain.shortName}`
  })()

  if (!enabled) {
    return (
      <div className="otc-desk">
        <h2>Instant OTC</h2>
        <p className="otc-desk-lead">Desk temporarily disabled.</p>
      </div>
    )
  }

  return (
    <div className="otc-desk">
      <div className="otc-desk-head">
        <div>
          <h2>Buy USDC on Arc</h2>
          <p className="otc-route">
            You pay on <strong>{payChain?.name ?? 'Base / ARB'}</strong>
            {' → '}
            you get USDC on <strong>Arc</strong>
          </p>
        </div>
        {isConnected ? (
          <button type="button" className="ab-btn ab-btn-ghost" onClick={() => disconnect()}>
            {short(address || '')}
          </button>
        ) : (
          <button
            type="button"
            className="ab-btn ab-btn-primary"
            onClick={() => connectors[0] && connect({ connector: connectors[0] })}
          >
            Connect
          </button>
        )}
      </div>

      <div className="otc-stats-bar otc-stats-bar-wide">
        <div className="otc-stat">
          <span className="otc-stat-label">Settled trades</span>
          <span className="otc-stat-value">
            {loading && deskStats.settledTrades === 0 ? '…' : deskStats.settledTrades.toLocaleString()}
          </span>
        </div>
        <div className="otc-stat">
          <span className="otc-stat-label">Volume</span>
          <span className="otc-stat-value accent">
            {loading && deskStats.volumeUsdc === 0n
              ? '…'
              : `${formatUsdcVolume(deskStats.volumeUsdc)} USDC`}
          </span>
        </div>
      </div>

      <div className="otc-stats-bar">
        <div className="otc-stat">
          <span className="otc-stat-label">Open liquidity</span>
          <span className="otc-stat-value accent">
            {loading && offers.length === 0 ? '…' : formatUsdCompact(openDepth)}
          </span>
        </div>
        <div className="otc-stat">
          <span className="otc-stat-label">Best all-in</span>
          <span className="otc-stat-value">
            {bestAllIn != null ? `${bestAllIn.toFixed(2)}×` : '—'}
          </span>
        </div>
        <div className="otc-stat">
          <span className="otc-stat-label">Platform fee</span>
          <span className="otc-stat-value">{effectiveFeeBps / 100}%</span>
        </div>
      </div>

      <p className="otc-fee-note">
        Platform fee <strong>{effectiveFeeBps / 100}%</strong> on maker proceeds. Premiums are set
        by makers; unsettled fills can be self-refunded after the timeout.
      </p>

      <div className="otc-toolbar">
        <div className="otc-mode" role="tablist">
          <button
            type="button"
            role="tab"
            className={mode === 'buy' ? 'active primary' : ''}
            onClick={() => setMode('buy')}
          >
            Buy on Arc
          </button>
          <button
            type="button"
            role="tab"
            className={mode === 'make' ? 'active' : ''}
            onClick={() => setMode('make')}
          >
            Create order
          </button>
        </div>

        {mode === 'buy' && (
          <div className="otc-chain-pills">
            <span className="otc-section-label">Pay on</span>
            {paymentOptions.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`otc-chain-pill${payChain?.id === c.id ? ' active' : ''}`}
                onClick={() => setPayId(c.id)}
              >
                {c.shortName}
              </button>
            ))}
            <button
              type="button"
              className="ab-btn ab-btn-ghost"
              style={{ fontSize: 11, padding: '4px 10px' }}
              onClick={() => void refresh()}
            >
              {loading ? '…' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      {mode === 'buy' && (
        <>
          {offers.length === 0 ? (
            <div className="otc-empty">
              <h3>No open offers</h3>
              <p>Be the first maker — post Arc USDC liquidity at your premium.</p>
              <button
                type="button"
                className="otc-cta"
                style={{ marginTop: 16, maxWidth: 280, marginLeft: 'auto', marginRight: 'auto' }}
                onClick={() => setMode('make')}
              >
                Create order
              </button>
            </div>
          ) : (
            <div className="otc-offer-grid">
              {offers.map((o) => {
                const available = o.available ?? o.remaining
                const pending = o.pendingReserved ?? 0n
                const locked = available <= 0n
                return (
                  <div
                    key={o.offerId}
                    className={`otc-offer-card${locked ? ' pending' : ''}${o.hasPending ? ' has-pending' : ''}`}
                  >
                    <div className="otc-offer-body">
                      <div className="otc-offer-tag-row">
                        <div className="otc-offer-tag">Premium</div>
                        {o.hasPending && (
                          <span className="otc-badge pending">
                            {locked ? 'pending' : 'partial pending'}
                          </span>
                        )}
                      </div>
                      <div className="otc-offer-premium">{premiumLabel(o.premiumBps)}</div>
                      <div className="otc-offer-allin">
                        {o.allInMult != null ? (
                          <>
                            <strong>{o.allInMult.toFixed(2)}×</strong> all-in — you pay{' '}
                            {o.allInMult.toFixed(2)} USDC per 1 USDC received, premium +{' '}
                            {effectiveFeeBps / 100}% platform fee.
                          </>
                        ) : (
                          <>Premium + {feeBps / 100}% platform fee at fill.</>
                        )}
                      </div>
                      <div className="otc-offer-rows">
                        <div className="otc-offer-row">
                          <span className="lbl">Available</span>
                          <span className="val">
                            {locked ? '0' : formatUsdc6(available)} USDC
                          </span>
                        </div>
                        {pending > 0n && (
                          <div className="otc-offer-row">
                            <span className="lbl">In flight</span>
                            <span className="val">{formatUsdc6(pending)} USDC pending</span>
                          </div>
                        )}
                        <div className="otc-offer-row">
                          <span className="lbl">Maker</span>
                          <span className="otc-maker-chip">{short(o.maker)}</span>
                        </div>
                      </div>
                    </div>
                    {locked ? (
                      <button type="button" className="otc-offer-buy otc-offer-buy-disabled" disabled>
                        Pending settlement
                      </button>
                    ) : (
                      <button type="button" className="otc-offer-buy" onClick={() => openFill(o)}>
                        Buy USDC on Arc
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {mode === 'make' && (
        <div className="otc-make-panel">
          <p className="otc-make-hint">
            Lock Arc USDC at your premium. You receive USDC on the chain the taker pays (
            {paymentSpokesLabel()}). Same EOA on every chain is fine.
          </p>
          <label className="otc-field">
            <span>Amount (Arc USDC)</span>
            <input
              className="otc-input"
              value={makeAmt}
              onChange={(e) => setMakeAmt(e.target.value)}
              placeholder="100"
              inputMode="decimal"
            />
          </label>
          <label className="otc-field">
            <span>Premium %</span>
            <input
              className="otc-input"
              value={premiumPct}
              onChange={(e) => setPremiumPct(e.target.value)}
              placeholder="5"
              inputMode="decimal"
            />
          </label>
          <label className="otc-field">
            <span>Payout address</span>
            <input
              className="otc-input mono-sm"
              value={sellerPayment}
              onChange={(e) => setSellerPayment(e.target.value)}
              placeholder="0x…"
            />
          </label>
          {makeAmt && Number(premiumPct) >= 0 && (
            <div className="otc-quote">
              <div className="otc-quote-row total">
                <span>Taker all-in (incl. fee)</span>
                <strong>{allInMultiplierSafe(Number(premiumPct) * 100, feeBps).toFixed(2)}×</strong>
              </div>
            </div>
          )}
          <button
            type="button"
            className="otc-cta"
            disabled={!isConnected || !makeAmt || busy}
            onClick={() => void onCreateOffer()}
          >
            {!isConnected
              ? 'Connect wallet'
              : busy
                ? 'Confirm in wallet…'
                : chainId === ARC_CHAIN_ID
                  ? 'Post offer on Arc'
                  : 'Switch to Arc & post'}
          </button>
        </div>
      )}

      {status && !fillOpen && <p className="otc-status">{status}</p>}
      {err && !fillOpen && <p className="otc-error">{err.slice(0, 280)}</p>}

      <div className="otc-foot">
        <details>
          <summary>Contracts · 30m self-refund if unsettled</summary>
          <pre>
            {paymentOptions.map((c) => `${c.shortName} ${c.payment}\n`).join('')}
            {`Arc ${ROBIN_OTC_LIQUIDITY}`}
          </pre>
        </details>
      </div>

      {fillOpen && selected && payChain && (
        <div
          className="otc-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFill()
          }}
        >
          <div
            className="otc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="otc-fill-title"
          >
            <div className="otc-modal-head">
              <h3 id="otc-fill-title">Fill offer</h3>
              <button
                type="button"
                className="otc-modal-close"
                aria-label="Close"
                disabled={busy}
                onClick={closeFill}
              >
                ×
              </button>
            </div>

            <p className="otc-modal-sub">
              {premiumLabel(selected.premiumBps)} premium · pay on <strong>{payChain.shortName}</strong>
              {selected.allInMult != null && (
                <> · {selected.allInMult.toFixed(2)}× all-in</>
              )}
            </p>

            <label className="otc-field">
              <span>Amount to receive on Arc</span>
              <div className="otc-amount-row">
                <input
                  className="otc-input otc-amount-input"
                  value={destAmt}
                  onChange={(e) => setDestAmt(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  autoFocus
                />
                <button type="button" className="otc-max" onClick={setMax}>
                  MAX
                </button>
                <span className="otc-unit">USDC</span>
              </div>
              <span className="otc-field-hint">
                Max {formatUsdc6(selected.available ?? selected.remaining)} USDC available
                {(selected.pendingReserved ?? 0n) > 0n
                  ? ` · ${formatUsdc6(selected.pendingReserved!)} pending settlement`
                  : ''}
              </span>
            </label>

            <div className="otc-field">
              <span>Recipient on Arc</span>
              <label className="otc-toggle-row">
                <input
                  type="checkbox"
                  checked={useDifferentRecipient}
                  disabled={busy}
                  onChange={(e) => {
                    const on = e.target.checked
                    setUseDifferentRecipient(on)
                    setRecipientConfirmed(false)
                    if (!on) setDestRecipient(address || '')
                  }}
                />
                <span>Send to a different address</span>
              </label>
              {!useDifferentRecipient ? (
                <div className="otc-recipient-locked mono-sm">
                  {address ? short(address) : '—'}
                  <span className="otc-field-hint" style={{ display: 'block', marginTop: 4 }}>
                    Connected wallet receives Arc USDC.
                  </span>
                </div>
              ) : (
                <>
                  <input
                    className="otc-input mono-sm"
                    value={destRecipient}
                    onChange={(e) => {
                      setDestRecipient(e.target.value)
                      setRecipientConfirmed(false)
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    disabled={busy}
                  />
                  {recipientOk && recipientIsDifferent && (
                    <label className="otc-confirm-row">
                      <input
                        type="checkbox"
                        checked={recipientConfirmed}
                        disabled={busy}
                        onChange={(e) => setRecipientConfirmed(e.target.checked)}
                      />
                      <span>
                        I confirm <strong className="mono-sm">{short(recipientAddr!)}</strong> will
                        receive the Arc USDC (irreversible once delivered).
                      </span>
                    </label>
                  )}
                  {!recipientOk && destRecipient.trim() && (
                    <span className="otc-field-hint" style={{ color: 'var(--otc-danger, #b45309)' }}>
                      Enter a valid address.
                    </span>
                  )}
                </>
              )}
            </div>

            {quote && (
              <div className="otc-quote">
                <div className="otc-quote-row">
                  <span>Maker proceeds</span>
                  <span>{formatUsdc6(quote.sellerProceeds)} USDC</span>
                </div>
                <div className="otc-quote-row">
                  <span>
                    Platform fee ({effectiveFeeBps / 100}%)
                  </span>
                  <span>{formatUsdc6(quote.serviceFee)} USDC</span>
                </div>
                <div className="otc-quote-row total">
                  <span>You pay on {payChain.shortName}</span>
                  <strong>{formatUsdc6(quote.total)} USDC</strong>
                </div>
              </div>
            )}

            <button
              type="button"
              className="otc-cta"
              disabled={
                !isConnected || !quote || !recipientReady || busy || !destAmt
              }
              onClick={() => {
                if (!isConnected) {
                  connectors[0] && connect({ connector: connectors[0] })
                  return
                }
                void onFill()
              }}
            >
              {ctaLabel}
            </button>

            {status && <p className="otc-status">{status}</p>}
            {err && <p className="otc-error">{err.slice(0, 280)}</p>}

            <p className="otc-modal-note">
              Your payment sits in escrow until the desk delivers. If delivery doesn&apos;t happen,
              you can reclaim it yourself after the timeout — no permission needed.
            </p>
            <p className="otc-modal-warn">
              If USDC is frozen by Circle, funds may be unrecoverable.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function allInMultiplierSafe(premiumBps: number, feeBps: number): number {
  try {
    const { total } = quoteFill(1_000_000n, Math.round(premiumBps), feeBps)
    return Number(total) / 1e6
  } catch {
    return 1
  }
}

function short(a: string) {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function formatUsdCompact(raw: bigint): string {
  const n = Number(raw) / 1e6
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `$${n.toFixed(2)}`
}

/** Volume display like Unstable (plain USDC amount, not $ prefix). */
function formatUsdcVolume(raw: bigint): string {
  const n = Number(raw) / 1e6
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return n.toFixed(4)
}
