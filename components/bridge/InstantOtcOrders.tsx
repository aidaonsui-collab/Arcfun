'use client'

/**
 * My orders — purchases (fills) + maker liquidity offers, read from chain.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { type Hex } from 'viem'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import {
  ROBIN_OTC_LIQUIDITY,
  PAYMENT_ABI,
  LIQUIDITY_ABI,
  robinOtcEnabled,
  fetchRecentFills,
  fetchFillById,
  fetchMakerOffers,
  loadLocalFillIds,
  formatUsdc6,
  premiumLabel,
  livePaymentChains,
  type OtcFill,
  type OtcOffer,
  type OtcPaymentChainId,
} from '@/lib/bridge/robin-otc'

export function InstantOtcOrders() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [purchases, setPurchases] = useState<OtcFill[]>([])
  const [offers, setOffers] = useState<OtcOffer[]>([])
  const [lookup, setLookup] = useState('')
  const [lookupChain, setLookupChain] = useState<OtcPaymentChainId>('base')
  const [lookupResult, setLookupResult] = useState<OtcFill | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  const enabled = robinOtcEnabled()
  const payChains = livePaymentChains()

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000)
    return () => clearInterval(t)
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setErr(null)
    try {
      const [chainFills, makerOffers] = await Promise.all([
        address ? fetchRecentFills({ buyer: address }) : Promise.resolve([] as OtcFill[]),
        address ? fetchMakerOffers(address) : Promise.resolve([] as OtcOffer[]),
      ])

      // Merge browser-local fill ids not in log window
      const local = loadLocalFillIds()
      const seen = new Set(chainFills.map((f) => f.fillId.toLowerCase()))
      const extras: OtcFill[] = []
      for (const loc of local) {
        if (seen.has(loc.fillId.toLowerCase())) continue
        if (address) {
          const f = await fetchFillById(loc.fillId, loc.chain)
          if (f && f.buyer.toLowerCase() === address.toLowerCase()) {
            extras.push(f)
            seen.add(f.fillId.toLowerCase())
          }
        }
      }

      const all = [...extras, ...chainFills]
      all.sort((a, b) => b.createdAt - a.createdAt)
      setPurchases(all)
      setOffers(makerOffers)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [enabled, address])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 20_000)
    return () => clearInterval(t)
  }, [refresh])

  const onLookup = async () => {
    setErr(null)
    setLookupResult(null)
    const id = lookup.trim() as Hex
    if (!id.startsWith('0x') || id.length !== 66) {
      setErr('Enter a 32-byte fill id (0x…)')
      return
    }
    try {
      const f = await fetchFillById(id, lookupChain)
      if (!f) setErr('Fill not found on that chain')
      else setLookupResult(f)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const onRefund = async (fill: OtcFill) => {
    if (!address) return
    setBusy(true)
    setErr(null)
    setStatus(null)
    try {
      if (chainId !== payChains.find((c) => c.id === fill.paymentChainId)?.chainId) {
        const c = payChains.find((x) => x.id === fill.paymentChainId)
        if (c) await switchChainAsync({ chainId: c.chainId })
      }
      const tx = await writeContractAsync({
        address: fill.paymentEscrow,
        abi: PAYMENT_ABI,
        functionName: 'refund',
        args: [fill.fillId],
        chainId: payChains.find((c) => c.id === fill.paymentChainId)?.chainId,
        gas: 200_000n,
      })
      setStatus(`Refund submitted ${tx.slice(0, 12)}…`)
      void refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onCancelOffer = async (offer: OtcOffer) => {
    if (!address) return
    if ((offer.pendingReserved ?? 0n) > 0n) {
      setErr('Cancel disabled while fills are pending settlement.')
      return
    }
    if (offer.remaining <= 0n) {
      setErr('No free residual to withdraw (all inventory reserved or empty).')
      return
    }
    setBusy(true)
    setErr(null)
    setStatus(null)
    try {
      if (chainId !== ARC_CHAIN_ID) await switchChainAsync({ chainId: ARC_CHAIN_ID })
      const tx = await writeContractAsync({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'cancelOffer',
        args: [offer.offerId],
        chainId: ARC_CHAIN_ID,
        gas: 200_000n,
      })
      setStatus(`Cancel submitted ${tx.slice(0, 12)}…`)
      void refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) {
    return (
      <div className="otc-desk">
        <h2>My orders</h2>
        <p className="otc-desk-lead">Instant OTC is not enabled.</p>
      </div>
    )
  }

  return (
    <div className="otc-desk">
      <div className="otc-desk-head">
        <div>
          <h2>My orders</h2>
          <p className="otc-desk-lead">
            Reads straight from chain — works even if the desk is down. Self-refund never needs
            anyone&apos;s permission after the timeout.
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

      <div className="otc-orders-lookup">
        <div className="otc-orders-lookup-label">Find an order</div>
        <div className="otc-orders-lookup-row">
          <select
            className="otc-input mono-sm otc-orders-select"
            value={lookupChain}
            onChange={(e) => setLookupChain(e.target.value as OtcPaymentChainId)}
          >
            {payChains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName}
              </option>
            ))}
          </select>
          <input
            className="otc-input mono-sm"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Fill id (0x…)"
            spellCheck={false}
          />
          <button type="button" className="ab-btn ab-btn-primary" onClick={() => void onLookup()}>
            Lookup
          </button>
        </div>
        {lookupResult && (
          <FillCard
            fill={lookupResult}
            now={now}
            busy={busy}
            canRefund={
              !!address &&
              lookupResult.status === 1 &&
              lookupResult.buyer.toLowerCase() === address.toLowerCase() &&
              now >= lookupResult.createdAt + (lookupResult.refundDelaySec ?? 1800)
            }
            onRefund={() => void onRefund(lookupResult)}
          />
        )}
      </div>

      <section className="otc-orders-section">
        <div className="otc-section-label">
          <span>Purchases</span>
          <button
            type="button"
            className="ab-btn ab-btn-ghost"
            style={{ fontSize: 11, padding: '2px 10px' }}
            onClick={() => void refresh()}
          >
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
        {!isConnected ? (
          <div className="otc-empty">
            <h3>Connect wallet</h3>
            <p>Purchases for this wallet will appear here with live status.</p>
          </div>
        ) : purchases.length === 0 ? (
          <div className="otc-empty">
            <h3>No purchases yet</h3>
            <p>Fill an offer on Trade — pending and settled fills show up here.</p>
          </div>
        ) : (
          <div className="otc-orders-list">
            {purchases.map((f) => (
              <FillCard
                key={`${f.paymentChainId}-${f.fillId}`}
                fill={f}
                now={now}
                busy={busy}
                canRefund={
                  f.status === 1 &&
                  !!address &&
                  f.buyer.toLowerCase() === address.toLowerCase() &&
                  now >= f.createdAt + (f.refundDelaySec ?? 1800)
                }
                onRefund={() => void onRefund(f)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="otc-orders-section">
        <div className="otc-section-label">
          <span>My liquidity offers</span>
        </div>
        {!isConnected ? (
          <div className="otc-empty">
            <h3>Connect wallet</h3>
            <p>Offers you posted on Arc will list here.</p>
          </div>
        ) : offers.length === 0 ? (
          <div className="otc-empty">
            <h3>No offers from this wallet</h3>
            <p>Post liquidity from Trade → Create order to earn maker premiums.</p>
          </div>
        ) : (
          <div className="otc-orders-list">
            {offers.map((o) => (
              <div key={o.offerId} className="otc-order-card">
                <div className="otc-order-top">
                  <span className="otc-order-title">{premiumLabel(o.premiumBps)} premium</span>
                  <StatusBadge
                    label={
                      !o.active
                        ? 'closed'
                        : (o.available ?? o.remaining) === 0n && (o.pendingReserved ?? 0n) > 0n
                          ? 'pending'
                          : o.active
                            ? 'open'
                            : 'closed'
                    }
                  />
                </div>
                <div className="otc-order-rows">
                  <div className="otc-offer-row">
                    <span className="lbl">On-chain remaining</span>
                    <span className="val">{formatUsdc6(o.remaining)} USDC</span>
                  </div>
                  {(o.pendingReserved ?? 0n) > 0n && (
                    <div className="otc-offer-row">
                      <span className="lbl">Pending fills</span>
                      <span className="val">{formatUsdc6(o.pendingReserved!)} USDC</span>
                    </div>
                  )}
                  <div className="otc-offer-row">
                    <span className="lbl">Available to fill</span>
                    <span className="val">{formatUsdc6(o.available ?? o.remaining)} USDC</span>
                  </div>
                  <div className="otc-offer-row">
                    <span className="lbl">Offer id</span>
                    <span className="otc-maker-chip">{short(o.offerId)}</span>
                  </div>
                </div>
                {o.active && o.remaining > 0n && (
                  <>
                    {(() => {
                      const pending = o.pendingReserved ?? 0n
                      const cancelBlocked = pending > 0n
                      return (
                        <>
                          <button
                            type="button"
                            className="otc-order-action otc-order-action-danger"
                            disabled={busy || cancelBlocked}
                            onClick={() => {
                              if (cancelBlocked) return
                              void onCancelOffer(o)
                            }}
                            title={
                              cancelBlocked
                                ? 'Cancel disabled while fills are pending settlement'
                                : undefined
                            }
                          >
                            {cancelBlocked
                              ? 'Cancel locked — pending fills'
                              : 'Cancel free residual & withdraw USDC'}
                          </button>
                          <p className="otc-order-hint">
                            {cancelBlocked
                              ? `${formatUsdc6(pending)} USDC is in flight. Cancel is disabled until those fills settle or refund. Free residual on-chain: ${formatUsdc6(o.remaining)} USDC (hard-reserved inventory stays locked until deliver/release).`
                              : `Returns free residual ${formatUsdc6(o.remaining)} USDC to your Arc wallet. Hard-reserved inventory cannot be cancelled. Not automatic — you must cancel.`}
                          </p>
                        </>
                      )
                    })()}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {status && <p className="otc-status">{status}</p>}
      {err && <p className="otc-error">{err.slice(0, 280)}</p>}
    </div>
  )
}

function FillCard({
  fill,
  now,
  busy,
  canRefund,
  onRefund,
}: {
  fill: OtcFill
  now: number
  busy: boolean
  canRefund: boolean
  onRefund: () => void
}) {
  const unlockAt = fill.createdAt + (fill.refundDelaySec ?? 1800)
  const secsLeft = Math.max(0, unlockAt - now)
  const isPending = fill.status === 1
  const isLocked = fill.status === 2
  const isInFlight = isPending || isLocked
  const badgeLabel =
    fill.statusLabel === 'locked' ? 'settling' : fill.statusLabel

  return (
    <div className="otc-order-card">
      <div className="otc-order-top">
        <span className="otc-order-title">
          {formatUsdc6(fill.destAmount)} USDC → Arc · pay {fill.paymentChainName}
        </span>
        <StatusBadge label={badgeLabel} />
      </div>
      <div className="otc-order-rows">
        <div className="otc-offer-row">
          <span className="lbl">You paid</span>
          <span className="val">
            {formatUsdc6(fill.sellerProceeds + fill.serviceFee)} USDC ({fill.paymentChainName})
          </span>
        </div>
        <div className="otc-offer-row">
          <span className="lbl">Recipient</span>
          <span className="otc-maker-chip">{short(fill.destRecipient)}</span>
        </div>
        <div className="otc-offer-row">
          <span className="lbl">Fill id</span>
          <span className="otc-maker-chip" title={fill.fillId}>
            {short(fill.fillId)}
          </span>
        </div>
        <div className="otc-offer-row">
          <span className="lbl">Escrow</span>
          <a
            className="otc-maker-chip otc-link"
            href={`${fill.explorer}/address/${fill.paymentEscrow}`}
            target="_blank"
            rel="noreferrer"
          >
            {fill.paymentChainName} {short(fill.paymentEscrow)}
          </a>
        </div>
        {isPending && (
          <div className="otc-offer-row">
            <span className="lbl">Self-refund</span>
            <span className="val">
              {canRefund ? 'Ready now' : secsLeft > 0 ? `Unlocks in ${fmtDuration(secsLeft)}` : 'Ready now'}
            </span>
          </div>
        )}
        {isLocked && (
          <div className="otc-offer-row">
            <span className="lbl">Self-refund</span>
            <span className="val">Blocked while settling</span>
          </div>
        )}
      </div>
      {isPending && (
        <>
          <button
            type="button"
            className={`otc-order-action${canRefund ? ' otc-order-action-primary' : ''}`}
            disabled={busy || !canRefund}
            onClick={onRefund}
          >
            {canRefund
              ? 'Refund — return USDC to my wallet'
              : `Refund available in ${fmtDuration(secsLeft)}`}
          </button>
          <p className="otc-order-hint">
            Not automatic. After the timeout, click Refund if the desk never settled. Requires the same
            wallet that paid on {fill.paymentChainName}.
          </p>
        </>
      )}
      {isLocked && (
        <p className="otc-order-hint">
          Settling — keeper is delivering Arc USDC. Self-refund is blocked until delivery fails and
          unlocks, or settle completes.
        </p>
      )}
      {fill.status === 3 && (
        <p className="otc-order-hint">Settled — maker paid, Arc USDC delivered.</p>
      )}
      {fill.status === 4 && (
        <p className="otc-order-hint">Refunded — escrow returned to buyer.</p>
      )}
      {!isInFlight && fill.status !== 3 && fill.status !== 4 && null}
    </div>
  )
}

function StatusBadge({ label }: { label: string }) {
  const cls =
    label === 'pending' || label === 'settling' || label === 'locked'
      ? 'otc-badge pending'
      : label === 'settled' || label === 'open'
        ? 'otc-badge settled'
        : label === 'refunded' || label === 'closed'
          ? 'otc-badge refunded'
          : 'otc-badge'
  return <span className={cls}>{label}</span>
}

function short(a: string) {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
