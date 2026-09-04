import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { isAddress, type Address } from 'viem'
import {
  ARCFUN_TOKEN,
  BURN_ADDRESS,
  CRUCIBLE_CONTRACTS_NOTE,
  emptyCrucibleStats,
  usesLegacyOnChainSplits,
} from '@/lib/crucible'
import { fetchCrucibleStats } from '@/lib/crucible-stats'
import { fetchTokenBurnedPct } from '@/lib/evm-holders'
import { getArcHomeCatalog } from '@/lib/arc-catalog-cache'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { ageLabel, fmtCompact, fmtUsd } from '@/lib/ui-format'
import { ExternalLink } from 'lucide-react'
import { CrucibleCountUp } from '@/components/CrucibleChip'

export const revalidate = 20

export const metadata: Metadata = {
  title: 'The Crucible — Arcfun',
  description:
    'Quote fees buy $EVE. Then it is gone. You trade. Fees accrue. When it cooks, Crucible buys $EVE and burns it.',
}

const RPC_DEADLINE_MS = 12_000

function withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), RPC_DEADLINE_MS)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const EVE_TOKEN = (
  ARCFUN_TOKEN && isAddress(ARCFUN_TOKEN)
    ? ARCFUN_TOKEN
    : '0x19209E55049bc613c5cC8b66B7DF7824096e78CF'
) as Address

const FEE_BARS = [
  { label: 'Creator', pct: 50 },
  { label: 'Crucible', pct: 25 },
  { label: 'Project burn', pct: 10 },
  { label: 'Platform', pct: 10 },
  { label: 'Referrer', pct: 5 },
] as const

async function liveBurnedPct(): Promise<number | null> {
  try {
    return await fetchTokenBurnedPct(EVE_TOKEN)
  } catch {
    return null
  }
}

async function eveMarketCap(): Promise<number | null> {
  try {
    const snap = await getArcHomeCatalog()
    const id = EVE_TOKEN.toLowerCase()
    const eve = snap.tokens.find((t) => (t.coinType || t.poolId || '').toLowerCase() === id)
    const mc = eve?.marketCap
    return Number.isFinite(mc) && (mc as number) > 0 ? (mc as number) : null
  } catch {
    return null
  }
}

export default async function CruciblePage() {
  const [livePct, eveMc] = await Promise.all([
    withDeadline<number | null>(liveBurnedPct(), null),
    withDeadline<number | null>(eveMarketCap(), null),
  ])
  const stats = await withDeadline(fetchCrucibleStats(livePct), emptyCrucibleStats(livePct))
  const explorer = ARC_EXPLORER || 'https://arc-scan.org'
  const burnedHref = `${explorer}/token/${EVE_TOKEN}?a=${BURN_ADDRESS}`
  const meltCount = stats.melts.length
  const card = 'rounded-[20px] bg-s1 border border-hair'

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-[1120px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <p className="m-0 text-xs font-medium tracking-[0.16em] text-t3 uppercase">Crucible</p>
        <h1 className="mt-2 mb-0 max-w-xl text-[1.85rem] sm:text-[2.1rem] font-semibold tracking-tight leading-tight text-balance">
          Quote fees buy $EVE. Then it is gone.
        </h1>
        <p className="mt-3 mb-0 max-w-xl text-sm leading-relaxed text-t2 text-pretty">
          Every launch on Arcfun takes a 1% USDC fee on buys. A slice of that fee sits in Crucible
          until it can buy $EVE and send it to the dead wallet. No clicks. No payout.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Burned"
            value={
              stats.burnedPct != null ? (
                <CrucibleCountUp value={stats.burnedPct} kind="pct" />
              ) : (
                '—'
              )
            }
            hint={
              stats.arcfunAtDead > 0 ? `${fmtCompact(stats.arcfunAtDead)} EVE` : 'of supply'
            }
            href={burnedHref}
          />
          <Stat
            label="USDC in"
            value={<CrucibleCountUp value={stats.usdcIn} kind="usd" />}
            hint={
              meltCount > 0
                ? `${meltCount} burn${meltCount === 1 ? '' : 's'}`
                : 'quote fees into Crucible'
            }
          />
          <Stat
            label="$EVE market cap"
            value={
              eveMc != null ? <CrucibleCountUp value={eveMc} kind="usd" /> : '—'
            }
            hint="Protocol token"
            href={`/token/${EVE_TOKEN}`}
            internal
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <section className={`${card} p-6`}>
            <h2 className="m-0 text-sm font-medium">Fee path · Meme</h2>
            <p className="mt-1 mb-0 text-xs text-t3">
              On a $100 buy, $1.00 splits across the pie.
            </p>
            <ul className="mt-5 mb-0 space-y-3 list-none p-0">
              {FEE_BARS.map((row) => (
                <li key={row.label}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{row.label}</span>
                    <span className="tabular-nums text-t3">{row.pct}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full crucible-bar"
                      style={{
                        width: `${row.pct * 2}%`,
                        background: 'rgba(126, 192, 247, 0.78)',
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-5 mb-0 text-xs text-t3">
              Sells: 1% in the launch token, 100% burned. Nobody is paid.
            </p>
            {usesLegacyOnChainSplits() ? (
              <p className="mt-4 mb-0 text-[12px] text-t3 leading-snug border-t border-hair2 pt-3">
                Next · {CRUCIBLE_CONTRACTS_NOTE}
              </p>
            ) : null}
          </section>

          <section className={`${card} p-6 flex flex-col`}>
            <h2 className="m-0 text-sm font-medium">Burn tape</h2>
            <div className="mt-4 flex-1 divide-y divide-hair2">
              {stats.melts.length === 0 ? (
                <p className="py-6 m-0 text-sm text-t3">No burns yet.</p>
              ) : (
                stats.melts.map((m, i) => (
                  <a
                    key={m.id}
                    href={`${explorer}/tx/${m.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View cook on explorer"
                    className="tape-row flex items-center justify-between gap-3 py-3 text-sm hover:text-white"
                    style={{ ['--tape-i' as string]: i }}
                  >
                    <span className="inline-flex items-center gap-2 text-t2 tabular-nums shrink-0">
                      {i === 0 ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot shrink-0" />
                      ) : (
                        <span className="w-1.5 h-1.5 shrink-0" aria-hidden />
                      )}
                      {ageLabel(m.ts)} ago
                    </span>
                    <span className="tabular-nums text-t2">{fmtUsd(m.usdcIn)} in</span>
                    <span className="tabular-nums font-medium text-right">
                      {fmtCompact(m.arcfunBurned)} EVE burned
                    </span>
                  </a>
                ))
              )}
            </div>
            <Link
              href={`/token/${EVE_TOKEN}`}
              className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-full bg-lime text-white text-sm font-semibold tracking-tightish hover:bg-lime-2 transition-colors"
            >
              Trade $EVE
            </Link>
          </section>
        </div>

        <p className="mt-6 mb-0 max-w-2xl text-[13px] text-t3 leading-relaxed">
          Referrals pay at swap time, on-chain, to the code&apos;s payout wallet. Anyone who
          bought can share their link later. Direct Uni or aggregator swaps have no code and pay
          nobody.
        </p>
      </div>
    </main>
  )
}

function Stat({
  label,
  value,
  hint,
  href,
  internal,
}: {
  label: string
  value: ReactNode
  hint: string
  href?: string
  internal?: boolean
}) {
  const inner = (
    <>
      <div className="text-[11px] text-t3 inline-flex items-center gap-1">
        {label}
        {href && !internal ? <ExternalLink className="w-3 h-3" /> : null}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-t3">{hint}</div>
    </>
  )
  const cls = 'rounded-[20px] bg-s1 border border-hair px-5 py-5 text-white no-underline'
  if (!href) return <div className={cls}>{inner}</div>
  if (internal) {
    return (
      <Link href={href} className={`${cls} hover:border-lime-line transition-colors`}>
        {inner}
      </Link>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="View burned supply on explorer"
      className={`${cls} hover:border-lime-line transition-colors`}
    >
      {inner}
    </a>
  )
}
