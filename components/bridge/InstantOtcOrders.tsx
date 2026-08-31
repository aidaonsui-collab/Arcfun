'use client'

/**
 * My orders — purchases (fills) + maker liquidity offers, read from chain.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
  fetchRecentSales,
  fetchFillById,
  fetchMakerOffers,
  mapApiOffers,
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
  const [sales, setSales] = useState<OtcFill[]>([])
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

  // Two independent scans that used to be one Promise.all([fetchRecentFills, fetchMakerOffers]) —
  // split apart 2026-08-31 after a live report: successful, settled fills were not appearing in
  // Purchases at all. Root cause was two compounding bugs, not one:
  //
  //   1. fetchMakerOffers scans from the liquidity contract's deploy block to chain head — on Arc
  //      that's ~4.4M blocks (KNOWN_LIQUIDITY_DEPLOY_FLOOR 14,000,000 vs. a head in the high
  //      18-millions), chunked at 9k blocks/request, 6 concurrent — routinely 30s-2min+ per call,
  //      confirmed by running it directly: it hadn't finished after 60s. fetchRecentFills, by
  //      contrast, is fast (bounded lookback, indexed by buyer topic).
  //   2. Promise.all([fetchRecentFills(...), fetchMakerOffers(...)]) means ANY rejection — and a
  //      multi-minute scan under real RPC conditions rejects often — discards the OTHER promise's
  //      result too. Purchases could fetch successfully and still never reach setPurchases()
  //      because its sibling call in the same Promise.all failed.
  //
  // Bundling the slow scan into the same 10s poll as the fast one (see the interval below) made
  // this far more visible — overlapping multi-minute scans stacking up every 10 seconds — but the
  // underlying bug pre-dates that change; it would eventually have surfaced at 30s too.
  //
  // Fix: two fully independent functions, each with its own re-entrancy guard (a ref, not state —
  // needs to be readable synchronously within the same tick an overlapping call could start) and
  // its own error handling, so a slow/failing offers scan can never block or discard a
  // successfully-fetched purchases list.
  const purchasesInFlight = useRef(false)
  const offersInFlight = useRef(false)

  const refreshPurchases = useCallback(async () => {
    if (!enabled || !address) {
      setPurchases([])
      return
    }
    if (purchasesInFlight.current) return
    purchasesInFlight.current = true
    setLoading(true)
    try {
      const chainFills = await fetchRecentFills({ buyer: address })

      // Merge browser-local fill ids not in log window
      const local = loadLocalFillIds()
      const seen = new Set(chainFills.map((f) => f.fillId.toLowerCase()))
      const extras: OtcFill[] = []
      for (const loc of local) {
        if (seen.has(loc.fillId.toLowerCase())) continue
        const f = await fetchFillById(loc.fillId, loc.chain)
        if (f && f.buyer.toLowerCase() === address.toLowerCase()) {
          extras.push(f)
          seen.add(f.fillId.toLowerCase())
        }
      }

      const all = [...extras, ...chainFills]
      all.sort((a, b) => b.createdAt - a.createdAt)
      setPurchases(all)
      setErr(null)
    } catch (e) {
      // Keep prior purchases when an Arc/Base RPC scan fails mid-poll.
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      purchasesInFlight.current = false
    }
  }, [enabled, address])

  const refreshOffersAndSales = useCallback(async () => {
    if (!enabled || !address) {
      setOffers([])
      setSales([])
      return
    }
    if (offersInFlight.current) return
    offersInFlight.current = true
    try {
      // Fast path: the same Goldsky/KV-cached book InstantOtcPanel.tsx's Trade tab already
      // reads (GET /api/otc/offers, sub-second) — filtered to this wallet's own maker address
      // client-side. A live offer with real remaining inventory (confirmed on-chain: 0xdf11...,
      // maker == this wallet, active, 1 USDC remaining) was showing "No offers from this
      // wallet" because fetchMakerOffers's live scan (see below) hadn't finished, or hadn't
      // even been given the chance to under the old 90s/Promise.all setup — same class of bug
      // as the purchases one, same fix: don't make the fast, common case wait on the slow one.
      //
      // fetchMakerOffers itself still exists and is correct (verified: it does eventually
      // return the right offer) — it's just genuinely a live ~4.1M-block Arc scan every call
      // (confirmed: still running past 60s), never cached, never incremental. Only fall back to
      // it when the indexed API is actually down, not merely reporting zero offers for this
      // wallet — same distinction InstantOtcPanel.tsx's own Trade-tab refresh already draws.
      let makerOffers: OtcOffer[] = []
      let indexOk = false
      try {
        const res = await fetch(`/api/otc/offers?maker=${address}`, { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as {
            ok?: boolean
            offers?: Parameters<typeof mapApiOffers>[0]
          }
          indexOk = data.ok !== false
          if (data.offers?.length) {
            makerOffers = mapApiOffers(data.offers).filter(
              (o) => o.maker.toLowerCase() === address.toLowerCase(),
            )
          }
        }
      } catch {
        /* index optional — falls through to indexOk === false below */
      }
      if (!indexOk) {
        makerOffers = await fetchMakerOffers(address)
      }

      setOffers((prev) => (makerOffers.length > 0 ? makerOffers : prev))
      try {
        const makerSales = await fetchRecentSales({
          seller: address,
          offerIds: makerOffers.map((o) => o.offerId),
        })
        setSales((prev) => (makerSales.length > 0 ? makerSales : prev))
      } catch (e) {
        console.warn('[otc] sales scan failed', e)
      }
    } catch (e) {
      // Own failure, own log line — never touches purchases state.
      console.warn('[otc] maker offers scan failed', e)
    } finally {
      offersInFlight.current = false
    }
  }, [enabled, address])

  useEffect(() => {
    void refreshPurchases()
    // 10s — fetchRecentFills is bounded/fast, safe to poll this often.
    const t = setInterval(() => void refreshPurchases(), 10_000)
    return () => clearInterval(t)
  }, [refreshPurchases])

  useEffect(() => {
    void refreshOffersAndSales()
    // 10s too, now that the fast path above is the default — the indexed API read is cheap
    // (same one the Trade tab already polls this often). Only the rare live-scan fallback is
    // slow, and it's naturally self-limiting: offersInFlight guards against a slow fallback
    // pass overlapping with the next tick.
    const t = setInterval(() => void refreshOffersAndSales(), 10_000)
    return () => clearInterval(t)
  }, [refreshOffersAndSales])

  const refreshAll = useCallback(() => {
    void refreshPurchases()
    void refreshOffersAndSales()
  }, [refreshPurchases, refreshOffersAndSales])

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
      void refreshPurchases()
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
      void refreshOffersAndSales()
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
            onClick={refreshAll}
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
          <span>Sales</span>
        </div>
        {!isConnected ? (
          <div className="otc-empty">
            <h3>Connect wallet</h3>
            <p>Fills against your offers — and payouts to this wallet — show here.</p>
          </div>
        ) : sales.length === 0 ? (
          <div className="otc-empty">
            <h3>No sales yet</h3>
            <p>When someone fills your book, the dest size and Base/ARB proceeds list here.</p>
          </div>
        ) : (
          <div className="otc-orders-list">
            {sales.map((f) => (
              <FillCard
                key={`sale-${f.paymentChainId}-${f.fillId}`}
                fill={f}
                now={now}
                busy={busy}
                canRefund={false}
                onRefund={() => undefined}
                mode="sale"
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
  mode = 'buy',
}: {
  fill: OtcFill
  now: number
  busy: boolean
  canRefund: boolean
  onRefund: () => void
  mode?: 'buy' | 'sale'
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
          {mode === 'sale'
            ? `${formatUsdc6(fill.destAmount)} USDC sold · paid on ${fill.paymentChainName}`
            : `${formatUsdc6(fill.destAmount)} USDC → Arc · pay ${fill.paymentChainName}`}
        </span>
        <StatusBadge label={badgeLabel} />
      </div>
      <div className="otc-order-rows">
        <div className="otc-offer-row">
          <span className="lbl">{mode === 'sale' ? 'You received' : 'You paid'}</span>
          <span className="val">
            {formatUsdc6(
              mode === 'sale' ? fill.sellerProceeds : fill.sellerProceeds + fill.serviceFee,
            )}{' '}
            USDC ({fill.paymentChainName})
          </span>
        </div>
        {mode === 'sale' && (
          <div className="otc-offer-row">
            <span className="lbl">Buyer</span>
            <span className="otc-maker-chip">{short(fill.buyer)}</span>
          </div>
        )}
        <div className="otc-offer-row">
          <span className="lbl">{mode === 'sale' ? 'Buyer received on Arc' : 'Recipient'}</span>
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
        {mode === 'buy' && isPending && (
          <div className="otc-offer-row">
            <span className="lbl">Self-refund</span>
            <span className="val">
              {canRefund ? 'Ready now' : secsLeft > 0 ? `Unlocks in ${fmtDuration(secsLeft)}` : 'Ready now'}
            </span>
          </div>
        )}
        {mode === 'buy' && isLocked && (
          <div className="otc-offer-row">
            <span className="lbl">Self-refund</span>
            <span className="val">Blocked while settling</span>
          </div>
        )}
      </div>
      {mode === 'buy' && isPending && (
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
          {mode === 'sale'
            ? 'Settling — keeper is delivering Arc USDC to the buyer. Your proceeds pay out on settle.'
            : 'Settling — keeper is delivering Arc USDC. Self-refund is blocked until delivery fails and unlocks, or settle completes.'}
        </p>
      )}
      {fill.status === 3 && fill.arcDelivered === true && (
        <p className="otc-order-hint">
          {mode === 'sale'
            ? 'Settled — proceeds sent to your payment wallet, Arc USDC delivered to the buyer.'
            : 'Settled — maker paid, Arc USDC delivered.'}
        </p>
      )}
      {fill.status === 3 && fill.arcDelivered === false && (
        <p className="otc-order-hint" style={{ color: 'var(--coral, #ff7a62)' }}>
          {mode === 'sale'
            ? 'Settled on the payment chain (you were paid) but Arc delivery did not complete.'
            : 'Settled on payment chain only — Arc delivery did not complete. Contact support for make-good; refund is not available after settle.'}
        </p>
      )}
      {fill.status === 3 && fill.arcDelivered == null && (
        <p className="otc-order-hint">Settled on payment chain (verifying Arc delivery…).</p>
      )}
      {fill.status === 4 && (
        <p className="otc-order-hint">
          {mode === 'sale'
            ? 'Refunded — buyer got their payment back; this sale did not complete.'
            : 'Refunded — escrow returned to buyer.'}
        </p>
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
