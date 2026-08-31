'use client'

/**
 * /otc — Arc OTC desk.
 * Escrowed Base/ARB USDC → Arc USDC. Not Circle CCTP.
 */
import { useState } from 'react'
import dynamic from 'next/dynamic'
import './otc.css'
import { robinOtcEnabled } from '@/lib/bridge/robin-otc'

const InstantOtcPanel = dynamic(
  () => import('@/components/bridge/InstantOtcPanel').then((m) => m.InstantOtcPanel),
  {
    ssr: false,
    loading: () => (
      <div className="ab-card ab-card-pad" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
        <p style={{ color: 'var(--ab-muted)', fontSize: 14 }}>Loading Arc OTC…</p>
      </div>
    ),
  },
)

const InstantOtcOrders = dynamic(
  () => import('@/components/bridge/InstantOtcOrders').then((m) => m.InstantOtcOrders),
  {
    ssr: false,
    loading: () => (
      <div className="ab-card ab-card-pad" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
        <p style={{ color: 'var(--ab-muted)', fontSize: 14 }}>Loading orders…</p>
      </div>
    ),
  },
)

type OtcTab = 'trade' | 'orders'

export default function ArcOtcPage() {
  const otcOn = robinOtcEnabled()
  const [tab, setTab] = useState<OtcTab>('trade')

  return (
    <div className="arc-bridge-page">
      <div className="arc-bridge-glow" aria-hidden />
      <div className="arc-bridge-inner otc-wide">
        <header className="arc-bridge-hero">
          <p className="arc-bridge-kicker">
            {tab === 'orders' ? 'Arcfun · My orders' : 'Arcfun · Base · ARB → Arc USDC'}
          </p>
          <h1 className="arc-bridge-title">
            <span>Arc OTC</span>
          </h1>
          {tab === 'orders' ? (
            <p className="arc-bridge-sub">
              Purchases and liquidity offers read from chain. Self-refund after timeout if a fill
              never settles.
            </p>
          ) : (
            <p className="arc-bridge-sub">
              Escrowed OTC for Arc USDC — maker-set premiums, flat platform fee, self-refund if
              unsettled. Not CCTP, not 1:1.
            </p>
          )}
        </header>

        {!otcOn ? (
          <div className="ab-card ab-card-pad" style={{ maxWidth: 520, margin: '0 auto' }}>
            <p style={{ color: 'var(--ab-muted)', fontSize: 14, textAlign: 'center', margin: 0 }}>
              Arc OTC is not configured. Liquidity or payment escrow addresses are missing — check
              deployment env or contact the team.
            </p>
          </div>
        ) : (
          <>
            <div className="otc-tabs-row" role="tablist">
              <button
                type="button"
                role="tab"
                className={`otc-nav-tab${tab === 'trade' ? ' active' : ''}`}
                aria-selected={tab === 'trade'}
                onClick={() => setTab('trade')}
              >
                Trade
              </button>
              <button
                type="button"
                role="tab"
                className={`otc-nav-tab${tab === 'orders' ? ' active' : ''}`}
                aria-selected={tab === 'orders'}
                onClick={() => setTab('orders')}
              >
                My orders
              </button>
            </div>

            {tab === 'orders' ? (
              <InstantOtcOrders />
            ) : (
              <InstantOtcPanel onViewOrders={() => setTab('orders')} />
            )}
          </>
        )}

        <p className="ab-footer-note">
          Neutral escrow desk · premiums set by makers · platform fee on settlement · 30m
          self-refund if unsettled. Not Circle CCTP.
        </p>
      </div>
    </div>
  )
}
