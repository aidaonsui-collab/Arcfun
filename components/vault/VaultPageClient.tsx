'use client'

/**
 * Eve Vault board. Product shell only.
 * Preview figures are samples. Instant / EveBurn / Crucible fee paths are unchanged.
 */
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { VaultDiagram } from '@/components/vault/VaultDiagram'
import { shortAddr } from '@/lib/ui-format'
import {
  VAULT,
  VAULT_FLOW_LEGS,
  VAULT_NETWORK,
  VAULT_PREVIEW,
  VAULT_PREVIEW_FLOW,
  VAULT_RWAS,
  VAULT_STACK,
  VAULT_STEPS,
  formatVaultUsd,
  projectedVault,
  type VaultFlowKind,
  type VaultRwa,
  type VaultRwaStatus,
} from '@/lib/vault-data'

type Tab = 'overview' | 'holdings' | 'flow'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'flow', label: 'Flow' },
]

const FLOW_KIND: Record<VaultFlowKind, { label: string; className: string }> = {
  in: { label: 'IN', className: 'border-lime-line text-lime-t' },
  hold: { label: 'HOLD', className: 'border-hair text-t2' },
  route: { label: 'ROUTE', className: 'border-hair text-t3' },
}

function pill(active: boolean) {
  return active
    ? 'border-lime-line bg-s2 text-white'
    : 'border-hair bg-s2 text-t2 hover:text-white hover:border-lime-line'
}

function partsUntil(target: Date, now: Date) {
  const ms = Math.max(0, target.getTime() - now.getTime())
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return { d, h, m, past: ms === 0 }
}

type VaultSnapshot = {
  configured: boolean
  treasuryAddress: string | null
  usdcBalance: string
  totalRoutedUsdc: string
  approvedRwaCount: number
  status: 'unconfigured' | 'escrowing' | 'awaiting_rwa_market'
}

const VAULT_STATUS_LABEL: Record<VaultSnapshot['status'], string> = {
  unconfigured: 'Stub',
  escrowing: 'Escrowing',
  awaiting_rwa_market: 'Awaiting market',
}

function usdcNum(raw: string): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n / 1e6 : 0
}

export function VaultPageClient() {
  const { address, isConnected } = useAccount()
  const [tab, setTab] = useState<Tab>('overview')
  const [preview, setPreview] = useState(false)
  const [monthlyFees, setMonthlyFees] = useState(4200)
  const [eveSlice, setEveSlice] = useState(8)
  const [rwaFilter, setRwaFilter] = useState<'all' | VaultRwaStatus>('all')
  const [selected, setSelected] = useState<VaultRwa | null>(null)
  const [now, setNow] = useState<Date | null>(null)
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/arc/vault', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: VaultSnapshot) => {
        if (!cancelled) setSnapshot(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const clock = now ? partsUntil(new Date(VAULT_NETWORK.windowDate), now) : null
  const math = projectedVault(monthlyFees, eveSlice)
  const rwas = rwaFilter === 'all' ? VAULT_RWAS : VAULT_RWAS.filter((r) => r.status === rwaFilter)
  const tiles = preview
    ? [
        { label: 'TVL', value: formatVaultUsd(VAULT_PREVIEW.tvl, 0), sub: 'sample board' },
        { label: 'USDC routed', value: formatVaultUsd(VAULT_PREVIEW.usdcRouted, 0), sub: 'platform fees to vault' },
        { label: 'RWA held', value: '$0', sub: 'none approved yet' },
        { label: 'Status', value: 'Preview', sub: 'not live' },
      ]
    : [
        {
          label: 'TVL',
          value: snapshot ? formatVaultUsd(usdcNum(snapshot.usdcBalance), 0) : '…',
          sub: snapshot?.configured ? 'live treasury balance' : 'treasury not configured',
        },
        {
          label: 'USDC routed',
          value: snapshot ? formatVaultUsd(usdcNum(snapshot.totalRoutedUsdc), 0) : '$0',
          sub: 'platform fees to vault, lifetime',
        },
        {
          label: 'RWA held',
          value: '$0',
          sub: snapshot?.approvedRwaCount ? `${snapshot.approvedRwaCount} approved` : 'none approved yet',
        },
        {
          label: 'Status',
          value: snapshot ? VAULT_STATUS_LABEL[snapshot.status] : 'Stub',
          sub: snapshot?.configured ? 'reading live chain data' : 'no fees move yet',
        },
      ]

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-8 sm:py-10">
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <Link href="/" className="inline-flex items-center text-sm font-medium text-t2 hover:text-white">
            ‹ Home
          </Link>
          <span className="inline-flex items-center rounded-full border border-hair bg-s2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
            Coming online
          </span>
          <span className="inline-flex items-center rounded-full border border-hair bg-s2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
            {VAULT.standard}
          </span>
        </div>

        <div className="grid items-center gap-10 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">The Eve Vault</p>
            <h1 className="m-0 mt-3 text-[32px] sm:text-[44px] font-semibold tracking-display leading-[1.08] text-white">
              Platform fees into real assets.
            </h1>
            <p className="mt-4 mb-0 max-w-xl text-[16px] text-t2 leading-relaxed">
              When tokenized RWAs are live on Arc, Instant's own platform-fee USDC can buy into a
              curated vault instead of sitting idle. This board is ready. The money is not. No fee
              split changes, no routing, until an explicit yes.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setTab('holdings')}
                className="h-9 px-4 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 transition-colors"
              >
                Open holdings
              </button>
              <button
                type="button"
                onClick={() => setPreview((v) => !v)}
                className={`h-9 px-4 rounded-xl border text-sm font-semibold transition-colors ${pill(preview)}`}
              >
                {preview ? 'Show empty shell' : 'Preview the board'}
              </button>
            </div>
            <p className="mt-5 mb-0 font-mono text-[12px] tabular-nums text-t3">
              {clock == null
                ? 'To Circle window'
                : clock.past
                  ? 'Circle window · Sep 16'
                  : `To Circle window · ${clock.d}d ${String(clock.h).padStart(2, '0')}h ${String(clock.m).padStart(2, '0')}m`}
            </p>
          </div>
          <div className="mt-8 lg:mt-0 flex justify-center lg:justify-end">
            <VaultDiagram className="max-w-[280px] sm:max-w-[320px] lg:max-w-[360px]" />
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`h-9 px-4 rounded-xl border text-sm font-semibold transition-colors ${pill(tab === t.id)}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          <Overview
            tiles={tiles}
            preview={preview}
            monthlyFees={monthlyFees}
            eveSlice={eveSlice}
            math={math}
            rwas={rwas}
            rwaFilter={rwaFilter}
            onFilter={setRwaFilter}
            onInspect={setSelected}
            onMonthlyFees={setMonthlyFees}
            onEveSlice={setEveSlice}
            usdcRouted={snapshot ? usdcNum(snapshot.totalRoutedUsdc) : 0}
          />
        ) : null}
        {tab === 'holdings' ? (
          <Holdings
            preview={preview}
            connected={isConnected}
            address={address}
            routed={VAULT_PREVIEW.usdcRouted}
          />
        ) : null}
        {tab === 'flow' ? <Flow preview={preview} /> : null}

        <p className="mt-8 mb-0 text-[14px] text-t3">
          Sibling product:{' '}
          <Link href="/crucible" className="text-t2 hover:text-white font-semibold">
            The Crucible
          </Link>{' '}
          (pad-wide buy/burn of $EVE).
        </p>
      </div>

      {selected ? <RwaInspect rwa={selected} preview={preview} onClose={() => setSelected(null)} /> : null}
    </main>
  )
}

function Overview({
  tiles,
  preview,
  monthlyFees,
  eveSlice,
  math,
  rwas,
  rwaFilter,
  onFilter,
  onInspect,
  onMonthlyFees,
  onEveSlice,
  usdcRouted,
}: {
  tiles: { label: string; value: string; sub: string }[]
  preview: boolean
  monthlyFees: number
  eveSlice: number
  math: ReturnType<typeof projectedVault>
  rwas: VaultRwa[]
  rwaFilter: 'all' | VaultRwaStatus
  onFilter: (f: 'all' | VaultRwaStatus) => void
  onInspect: (r: VaultRwa) => void
  onMonthlyFees: (n: number) => void
  onEveSlice: (n: number) => void
  usdcRouted: number
}) {
  const series = useMemo(
    () =>
      preview
        ? math.months.map((m) => ({ i: m.month, v: m.value + VAULT_PREVIEW.tvl * 0.04 * m.month }))
        : [],
    [preview, math],
  )
  const maxV = series.reduce((m, p) => Math.max(m, p.v), 1)
  const path = series
    .map((p, i) => {
      const x = series.length <= 1 ? 0 : (i / (series.length - 1)) * 240
      const y = 72 - (p.v / maxV) * 64
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <>
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-px bg-hair2 border border-hair rounded-[24px] overflow-hidden">
        {tiles.map((m) => (
          <div key={m.label} className="px-5 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0">
            <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 whitespace-nowrap">
              {m.label}
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-[-0.028em] leading-tight truncate">
              {m.value}
            </span>
            <span className="text-xs font-semibold tabular-nums text-t3">{m.sub}</span>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {VAULT_STACK.map((s) => (
          <div key={s.label} className="rounded-[20px] border border-hair bg-s1 px-4 py-3">
            <p className="m-0 text-sm font-semibold tracking-tightish">{s.label}</p>
            <p className="m-0 mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-t3">{s.detail}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="border border-hair rounded-[24px] bg-s1 p-5 sm:p-6">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Vault</p>
          <h2 className="m-0 mt-2 text-[17px] font-semibold tracking-tightish">Total value locked</h2>
          <p className="mt-4 mb-0 text-[36px] font-semibold tabular-nums tracking-display">
            {preview ? formatVaultUsd(VAULT_PREVIEW.tvl, 0) : '$0'}
          </p>
          <p className="mt-1 mb-0 text-sm text-t3">
            {preview
              ? `Sample board · ${VAULT_PREVIEW.pools} queued markets · ${VAULT_PREVIEW.active} active`
              : 'Waiting on Arc RWA · no fees move yet'}
          </p>
          <div className="mt-4 h-20">
            {preview && path ? (
              <svg viewBox="0 0 240 72" className="h-full w-full" aria-hidden>
                <path d={path} fill="none" stroke="var(--limeT)" strokeWidth="1.6" />
              </svg>
            ) : (
              <div className="flex h-full items-end gap-1">
                {Array.from({ length: 24 }, (_, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-sm bg-s2"
                    style={{ height: `${12 + (i % 5) * 8}%` }}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <MiniStat
              label="USDC routed"
              value={preview ? formatVaultUsd(VAULT_PREVIEW.usdcRouted, 0) : formatVaultUsd(usdcRouted, 0)}
              hint="platform fees to vault, lifetime"
            />
            <MiniStat
              label="Last Instant legs"
              value={preview ? formatVaultUsd(VAULT_PREVIEW.lastDeposits) : '$0'}
              hint="sample USDC, Instant events"
            />
          </div>
        </section>
        <CashFlow preview={preview} />
      </div>

      <section className="mt-8">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">How it would work</p>
        <h2 className="m-0 mt-2 text-[20px] font-semibold tracking-tightish">
          Three legs. One vault. No split change until you say yes.
        </h2>
        <ol className="mt-5 grid gap-3 md:grid-cols-3">
          {VAULT_STEPS.map((s) => (
            <li key={s.n} className="rounded-[24px] border border-hair bg-s1 p-5">
              <p className="m-0 font-mono text-[11px] tracking-[0.14em] text-lime-t">{s.n}</p>
              <h3 className="m-0 mt-3 text-[16px] font-semibold tracking-tightish">{s.title}</h3>
              <p className="mt-2 mb-0 text-sm leading-relaxed text-t2">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Approved RWAs</p>
            <h2 className="m-0 mt-2 text-[20px] font-semibold tracking-tightish">
              Queued until something ships on 5042
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'queued', 'candidate'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilter(f)}
                className={`h-8 px-3 rounded-xl border text-xs font-semibold capitalize transition-colors ${pill(rwaFilter === f)}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 mb-0 text-sm text-t3">
          Showing {rwas.length} of {VAULT_RWAS.length} curator names · 0 live on Arc
        </p>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {rwas.map((rwa) => (
            <article key={rwa.id} className="rounded-[24px] border border-hair bg-s1 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-s2 font-mono text-[11px] tracking-[0.08em] text-lime-t">
                    {rwa.letters}
                  </div>
                  <div>
                    <p className="m-0 text-[15px] font-semibold tracking-tightish">{rwa.ticker}</p>
                    <p className="m-0 text-sm text-t3">{rwa.issuer}</p>
                  </div>
                </div>
                <span className="rounded-full border border-hair px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                  {rwa.status}
                </span>
              </div>
              <p className="mt-4 mb-0 text-sm leading-relaxed text-t2">{rwa.name}</p>
              <p className="mt-1 mb-0 text-xs text-t3">{rwa.kind}</p>
              <dl className="mt-4 grid grid-cols-3 gap-2">
                <MiniStat label="Expected APY" value={preview ? `${rwa.expectedApy.toFixed(2)}%` : 'n/a'} hint="" />
                <MiniStat label="Max weight" value={`${rwa.maxWeight}%`} hint="" />
                <MiniStat label="Held" value="$0" hint="" />
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onInspect(rwa)}
                  className="h-8 px-3 rounded-xl bg-lime text-white text-xs font-semibold hover:bg-lime-2 transition-colors"
                >
                  Inspect {rwa.ticker}
                </button>
                <button
                  type="button"
                  disabled
                  className="h-8 px-3 rounded-xl border border-hair bg-s2 text-t3 text-xs font-semibold opacity-60"
                >
                  Buy when listed
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-[24px] border border-hair bg-s1 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">The math</p>
            <h2 className="m-0 mt-2 text-[20px] font-semibold tracking-tightish">
              If Instant fees started routing tomorrow
            </h2>
          </div>
          <span className="rounded-full border border-hair px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
            Projection · not live
          </span>
        </div>
        <p className="mt-3 mb-0 max-w-2xl text-sm leading-relaxed text-t2">
          Size a monthly Instant USDC clip and an optional $EVE slice. The rest is what a keeper
          would send into the ERC-4626 vault, using a BUIDL-like T-bill rate for the projection.
        </p>
        <div className="mt-7 grid gap-8 lg:grid-cols-2">
          <div className="space-y-6">
            <label className="block">
              <span className="flex items-baseline justify-between text-sm">
                <span className="text-t2">Monthly Instant USDC</span>
                <span className="font-mono tabular-nums">{formatVaultUsd(monthlyFees, 0)}</span>
              </span>
              <input
                type="range"
                min={200}
                max={20000}
                step={100}
                value={monthlyFees}
                onChange={(e) => onMonthlyFees(Number(e.target.value))}
                className="mt-3 w-full accent-[var(--lime)]"
              />
            </label>
            <label className="block">
              <span className="flex items-baseline justify-between text-sm">
                <span className="text-t2">Optional $EVE slice</span>
                <span className="font-mono tabular-nums">{eveSlice}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={eveSlice}
                onChange={(e) => onEveSlice(Number(e.target.value))}
                className="mt-3 w-full accent-[var(--lime)]"
              />
            </label>
            <div className="flex h-3 overflow-hidden rounded-full bg-s2">
              <div className="bg-lime-t" style={{ width: `${100 - eveSlice}%` }} />
              <div className="bg-[#c4a574]" style={{ width: `${eveSlice}%` }} />
            </div>
            <p className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-t3">
              Ice = vault · Warm = $EVE
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MiniStat label="To vault / mo" value={formatVaultUsd(math.toVault, 0)} hint="" />
            <MiniStat label="To $EVE / mo" value={formatVaultUsd(math.toEve, 0)} hint="" />
            <MiniStat label="Deployed / yr" value={formatVaultUsd(math.yearly, 0)} hint="" />
            <MiniStat label="Expected APY" value={`${(math.apy * 100).toFixed(2)}%`} hint="" />
            <div className="col-span-2 rounded-2xl bg-s2 p-4">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-t3">
                Net extra on idle USDC
              </p>
              <p className="mt-2 mb-0 text-[28px] font-semibold tabular-nums tracking-display text-lime-t">
                +{formatVaultUsd(math.yieldYear, 0)}
                <span className="ml-2 text-base text-t3">/ yr</span>
              </p>
              <p className="mt-2 mb-0 text-sm text-t3">
                Month 12 vault balance {formatVaultUsd(math.months[12]?.value ?? 0, 0)} if the clip
                compounds at that rate. Still zero on-chain today.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

function Holdings({
  preview,
  connected,
  address,
  routed,
}: {
  preview: boolean
  connected: boolean
  address?: string
  routed: number
}) {
  return (
    <div className="mt-6">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Holdings</p>
      <h2 className="m-0 mt-2 text-[28px] font-semibold tracking-display">Your Instant clip, on the vault.</h2>
      <p className="mt-3 mb-0 max-w-xl text-t2">
        Positions stay empty until Arcfun signs fee routing and an RWA lists on Arc. Connect with
        the header wallet to see how the board will read.
      </p>

      {!connected ? (
        <div className="mt-6 rounded-[24px] border border-hair bg-s1 p-6">
          <p className="m-0 text-[17px] font-semibold tracking-tightish">Connect to read a position</p>
          <p className="mt-2 mb-0 max-w-md text-sm text-t3">
            Use Connect in the Arcfun header. No vault contract to sign. No funds move.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          <MiniStat label="Wallet" value={shortAddr(address)} hint="connected" />
          <MiniStat
            label="Instant USDC"
            value={preview ? formatVaultUsd(1840, 0) : '$0'}
            hint="accrued platform fees"
          />
          <MiniStat label={`${VAULT.shareSymbol} shares`} value="0.00" hint="ERC-4626 · none minted" />
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[24px] border border-hair bg-s1 p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-[17px] font-semibold tracking-tightish">Vault slice</h3>
            <span className="rounded-full border border-hair px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              Stub
            </span>
          </div>
          <p className="mt-4 mb-0 text-[36px] font-semibold tabular-nums tracking-display">
            {preview && connected ? formatVaultUsd(routed * 0.04, 0) : '$0'}
          </p>
          <p className="mt-2 mb-0 text-sm text-t3">
            Share of eveRWA that would print against your Instant USDC. Zero until the keeper is
            armed.
          </p>
          <button
            type="button"
            disabled
            className="mt-5 h-9 px-4 rounded-xl border border-hair bg-s2 text-t3 text-sm font-semibold opacity-60"
          >
            Deposit when live
          </button>
        </article>
        <article className="rounded-[24px] border border-hair bg-s1 p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-[17px] font-semibold tracking-tightish">$EVE slice</h3>
            <span className="rounded-full border border-hair px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              Optional later
            </span>
          </div>
          <p className="mt-4 mb-0 text-[36px] font-semibold tabular-nums tracking-display">$0</p>
          <p className="mt-2 mb-0 text-sm text-t3">
            A later toggle can leave a cut cooking $EVE instead of buying RWA. Off by default. Not
            wired.
          </p>
          <button
            type="button"
            disabled
            className="mt-5 h-9 px-4 rounded-xl border border-hair bg-s2 text-t3 text-sm font-semibold opacity-60"
          >
            Leave a slice cooking
          </button>
        </article>
      </div>
    </div>
  )
}

function Flow({ preview }: { preview: boolean }) {
  return (
    <div className="mt-6">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Flow</p>
      <h2 className="m-0 mt-2 text-[28px] font-semibold tracking-display">How USDC would clear.</h2>
      <p className="mt-3 mb-0 max-w-xl text-t2">
        Five legs from Instant to the vault. Today the pipe stops at escrow. Public Arc RWAs are
        expected around Circle&apos;s September 16 window.
      </p>
      <ol className="mt-6 grid gap-3 md:grid-cols-5">
        {VAULT_FLOW_LEGS.map((leg) => (
          <li key={leg.n} className="rounded-[24px] border border-hair bg-s1 p-4">
            <p className="m-0 font-mono text-[11px] tracking-[0.14em] text-lime-t">{leg.n}</p>
            <h3 className="m-0 mt-2 text-[16px] font-semibold tracking-tightish">{leg.title}</h3>
            <p className="mt-2 mb-0 text-sm leading-relaxed text-t2">{leg.body}</p>
            <span
              className={`mt-4 inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ${
                leg.live ? 'border-lime-line text-lime-t' : 'border-hair text-t3'
              }`}
            >
              {leg.live ? 'Live on Instant' : 'Waiting'}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <CashFlow preview={preview} />
        <section className="rounded-[24px] border border-hair bg-s1 p-5 sm:p-6">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Keeper</p>
          <h3 className="m-0 mt-2 text-[17px] font-semibold tracking-tightish">Armed after an explicit yes</h3>
          <dl className="mt-5 mb-0 space-y-0 text-sm">
            <KeeperRow k="Status" v="Stub · no bot, no key, no buy" />
            <KeeperRow k="Allowed buys" v="Curator list only (empty on 5042)" />
            <KeeperRow k="Vault" v="ERC-4626 · eveRWA shares" />
            <KeeperRow k="Unwind" v="Redeem shares to USDC / RWA, no lockup planned" />
            <KeeperRow k="Sibling" v="Crucible still handles pad-wide $EVE buy/burn" />
          </dl>
        </section>
      </div>
    </div>
  )
}

function CashFlow({ preview }: { preview: boolean }) {
  const rows = preview ? VAULT_PREVIEW_FLOW : []
  return (
    <section className="flex flex-col rounded-[24px] border border-hair bg-s1 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-t3">Cash flow</p>
          <h2 className="m-0 mt-2 text-[17px] font-semibold tracking-tightish">Instant → vault</h2>
        </div>
        <span className="rounded-full border border-hair px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
          {preview ? 'Sample' : 'Idle'}
        </span>
      </div>
      <ul className="mt-4 mb-0 flex flex-1 flex-col divide-y divide-hair2">
        {rows.length === 0 ? (
          <li className="py-10 text-sm text-t3">
            No fees move yet. Instant still pays creators in USDC. A keeper will only route after an
            approved RWA lists on 5042 and Arcfun signs the split.
          </li>
        ) : (
          rows.map((ev) => {
            const k = FLOW_KIND[ev.kind]
            return (
              <li key={ev.id} className="flex items-center gap-3 py-3">
                <span
                  className={`w-14 shrink-0 rounded-full border text-center text-[10px] font-semibold tracking-[0.08em] ${k.className}`}
                >
                  {k.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm">{ev.source}</p>
                  <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-t3">{ev.ago}</p>
                </div>
                <p className="m-0 font-mono text-sm tabular-nums">{formatVaultUsd(ev.amount)}</p>
              </li>
            )
          })
        )}
      </ul>
    </section>
  )
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl bg-s2 px-3 py-3">
      <p className="m-0 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">{label}</p>
      <p className="m-0 mt-1 text-[15px] font-semibold tabular-nums tracking-tightish">{value}</p>
      {hint ? <p className="m-0 mt-0.5 text-xs text-t3">{hint}</p> : null}
    </div>
  )
}

function KeeperRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hair2 py-3 last:border-0">
      <dt className="text-t3">{k}</dt>
      <dd className="m-0 max-w-[62%] text-right">{v}</dd>
    </div>
  )
}

function RwaInspect({
  rwa,
  preview,
  onClose,
}: {
  rwa: VaultRwa
  preview: boolean
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/60" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rwa-inspect-title"
        className="relative w-full max-w-md rounded-[24px] border border-hair bg-s1 p-5 sm:p-6"
      >
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-t3">{rwa.ticker}</p>
        <h2 id="rwa-inspect-title" className="m-0 mt-2 text-[18px] font-semibold tracking-tightish">
          {rwa.name}
        </h2>
        <p className="mt-2 mb-0 text-sm leading-relaxed text-t2">{rwa.note}</p>
        <dl className="mt-5 grid grid-cols-2 gap-2 text-sm">
          <MiniStat label="Issuer" value={rwa.issuer} hint="" />
          <MiniStat label="Kind" value={rwa.kind} hint="" />
          <MiniStat label="Status" value={rwa.status} hint="" />
          <MiniStat label="Max weight" value={`${rwa.maxWeight}%`} hint="" />
          <MiniStat label="Expected APY" value={preview ? `${rwa.expectedApy.toFixed(2)}%` : 'n/a'} hint="" />
          <MiniStat label="Oracle" value="Awaiting Arc listing" hint="" />
        </dl>
        <p className="mt-4 mb-0 rounded-full border border-hair px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 inline-flex">
          Not purchasable · no money moves
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 h-9 w-full rounded-xl border border-hair bg-s2 text-sm font-semibold text-white hover:border-lime-line"
        >
          Close
        </button>
      </div>
    </div>
  )
}
