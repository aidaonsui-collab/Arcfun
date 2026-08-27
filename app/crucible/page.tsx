import type { Metadata } from 'next'
import Link from 'next/link'
import { isAddress, type Address } from 'viem'
import {
  ARCFUN_TOKEN,
  BURN_ADDRESS,
  CRUCIBLE_CONTRACTS_NOTE,
  mockCrucibleStats,
  usesLegacyOnChainSplits,
} from '@/lib/crucible'
import { fetchTokenBurnedPct } from '@/lib/evm-holders'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { ageLabel, fmtCompact, fmtUsd } from '@/lib/ui-format'
import { ExternalLink } from 'lucide-react'
import { CrucibleFeePath } from '@/components/CrucibleFeePath'
import { CrucibleCountUp } from '@/components/CrucibleChip'

export const revalidate = 20

export const metadata: Metadata = {
  title: 'The Crucible — Arcfun',
  description:
    'A buy/burn no one has to click. You trade. Fees accrue. When it cooks, Crucible buys $ARCFUN and burns it.',
}

async function liveBurnedPct(): Promise<number | null> {
  if (!ARCFUN_TOKEN || !isAddress(ARCFUN_TOKEN)) return null
  try {
    return await fetchTokenBurnedPct(ARCFUN_TOKEN as Address)
  } catch {
    return null
  }
}

export default async function CruciblePage() {
  const livePct = await liveBurnedPct()
  const stats = mockCrucibleStats(Date.now(), livePct)
  const explorer = ARC_EXPLORER || 'https://arc-scan.org'
  const burnedHref = ARCFUN_TOKEN
    ? `${explorer}/token/${ARCFUN_TOKEN}?a=${BURN_ADDRESS}`
    : `${explorer}/address/${BURN_ADDRESS}`
  const preview = stats.preview || usesLegacyOnChainSplits()

  const meltCount = stats.melts.length
  const tiles = [
    {
      label: 'Burned',
      value: (
        <CrucibleCountUp value={stats.burnedPct ?? 0} kind="pct" />
      ),
      sub: 'of supply',
      subColor: 'var(--limeT)',
      bar: stats.burnedPct,
      live: livePct != null,
      href: burnedHref,
    },
    {
      label: 'USDC in',
      value: <CrucibleCountUp value={stats.usdcIn} kind="usd" />,
      sub: 'quote fees into Crucible',
      subColor: 'var(--t3)',
      bar: null as number | null,
      live: false,
      href: null as string | null,
    },
    {
      label: 'ARCFUN bought',
      value: <CrucibleCountUp value={stats.arcfunBought} kind="compact" />,
      sub: 'from USDC burns',
      subColor: 'var(--limeT)',
      bar: null,
      live: false,
      href: null,
    },
    {
      label: 'ARCFUN removed',
      value: <CrucibleCountUp value={stats.arcfunAtDead} kind="compact" />,
      sub: `${meltCount} burn${meltCount === 1 ? '' : 's'}`,
      subColor: 'var(--limeT)',
      bar: null,
      live: false,
      href: burnedHref,
    },
  ]

  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-8 sm:py-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-t2 hover:text-white mb-5"
        >
          ‹ Home
        </Link>

        <h1 className="m-0 text-[32px] sm:text-[40px] font-semibold tracking-display leading-[1.12]">
          The Crucible
        </h1>
        <p className="m-0 mt-3 text-[18px] font-semibold tracking-tightish text-white">
          A buy/burn no one has to click.
        </p>
        <p className="mt-3 mb-0 max-w-2xl text-[16px] text-t2 leading-relaxed">
          You trade. Fees accrue. When it cooks, Crucible buys $ARCFUN and burns it. Referrals on
          Arcfun buys are extra, and instant.
        </p>

        {preview ? (
          <p className="mt-4 mb-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-hair bg-s2 text-[12px] font-semibold text-t2">
            Burn tape · preview, events not indexed yet
          </p>
        ) : null}

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px bg-hair2 border border-hair rounded-[24px] overflow-hidden">
          {tiles.map((m) => {
            const inner = (
              <>
                <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-t3 whitespace-nowrap inline-flex items-center gap-1">
                  {m.label}
                  {m.href ? <ExternalLink className="w-3 h-3" /> : null}
                </span>
                <span
                  className="text-2xl font-semibold tabular-nums tracking-[-0.028em] leading-tight truncate"
                  style={m.bar != null ? { color: 'var(--limeT)' } : undefined}
                >
                  {m.value}
                </span>
                {m.bar != null && Number.isFinite(m.bar) ? (
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full crucible-bar"
                      style={{
                        width: `${Math.min(100, Math.max(0, m.bar))}%`,
                        background: 'var(--limeT)',
                      }}
                    />
                  </div>
                ) : null}
                <span className="text-xs font-semibold tabular-nums" style={{ color: m.subColor }}>
                  {m.sub}
                </span>
              </>
            )
            const cls = 'px-5 py-[18px] bg-s1 flex flex-col gap-1.5 min-w-0'
            return m.href ? (
              <a
                key={m.label}
                href={m.href}
                target="_blank"
                rel="noopener noreferrer"
                title="View burned supply on explorer"
                className={`${cls} hover:bg-s2 transition-colors`}
              >
                {inner}
              </a>
            ) : (
              <div key={m.label} className={cls}>
                {inner}
              </div>
            )
          })}
        </div>

        <div className="mt-5">
          <CrucibleFeePath kind="meme" notionalUsdc={100} />
        </div>

        <section className="mt-5 border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-4 border-b border-hair2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Burn tape</h2>
              <p className="m-0 mt-0.5 text-[13px] text-t3">
                {stats.lastMelt
                  ? `Last burn ${ageLabel(stats.lastMelt.ts)} ago`
                  : 'No burns yet'}
                {' · '}
                preview until buy/burn events exist
              </p>
            </div>
          </div>
          {stats.melts.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-t3">No burns yet.</p>
          ) : (
            <>
            <div className="sm:hidden divide-y divide-hair2">
              {stats.melts.map((m, i) => (
                <div
                  key={m.id}
                  className="tape-row px-5 py-3.5 flex flex-col gap-1.5"
                  style={{ ['--tape-i' as string]: i }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-[13px] text-t2 tabular-nums">
                      {i === 0 ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot shrink-0" />
                      ) : null}
                      {ageLabel(m.ts)} ago
                    </span>
                    <span className="text-[15px] font-semibold tabular-nums text-coral">
                      {fmtCompact(m.arcfunBurned)} burned
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] text-t3 tabular-nums">
                    <span>{fmtUsd(m.usdcIn)} in</span>
                    <span>{fmtCompact(m.arcfunBought)} bought</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[12px] font-semibold text-t3 border-b border-hair2">
                    <th className="px-5 py-3 font-semibold">When</th>
                    <th className="px-5 py-3 font-semibold text-right">USDC in</th>
                    <th className="px-5 py-3 font-semibold text-right">ARCFUN bought</th>
                    <th className="px-5 py-3 font-semibold text-right">Burned</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.melts.map((m, i) => (
                    <tr
                      key={m.id}
                      className="tape-row border-b border-hair2 last:border-0"
                      style={{ ['--tape-i' as string]: i }}
                    >
                      <td className="px-5 py-3 text-t2 tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          {i === 0 ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-lime-t live-dot shrink-0" />
                          ) : (
                            <span className="w-1.5 h-1.5 shrink-0" aria-hidden />
                          )}
                          {ageLabel(m.ts)} ago
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-semibold">
                        {fmtUsd(m.usdcIn)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-t2">
                        {fmtCompact(m.arcfunBought)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-coral font-semibold">
                        {fmtCompact(m.arcfunBurned)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </section>

        <section className="mt-5 border border-hair rounded-[24px] bg-s1 p-5 sm:p-6">
          <h2 className="m-0 text-[17px] font-semibold tracking-tightish">Payout trail</h2>
          <p className="mt-2 mb-0 text-[14px] text-t2 leading-relaxed">
            Referrals pay at swap time, on-chain, to the code&apos;s payout wallet. Anyone who
            bought can share their link later. Direct Uni or aggregator swaps have no code and
            pay nobody.
          </p>
          {usesLegacyOnChainSplits() ? (
            <p className="mt-3 mb-0 text-[13px] text-t3 leading-snug">{CRUCIBLE_CONTRACTS_NOTE}</p>
          ) : null}
        </section>
      </div>
    </main>
  )
}
