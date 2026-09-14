'use client'

/**
 * RWA holder basket on create. Not Argus tax chrome: eve.fun lime-navy, same
 * family as FeeSplitCard. Holders earn converted basket assets, never the raw MMF.
 */
import { listRwaAssets, type ArcRwaAsset } from '@/lib/arc-rwa-assets'
import {
  BUNDLE_DEFAULT_FEE,
  BUNDLE_DEFAULT_TICK_SPACING,
  basketValid,
  basketWeightSum,
  catalogBasketOptions,
  equalWeightsBps,
  type BasketRow,
  type BundlePayoutMode,
} from '@/lib/rwa-bundle'
import { isAddress } from 'viem'

const FEE_TIERS: { fee: number; tick: number; label: string }[] = [
  { fee: 500, tick: 10, label: '0.05%' },
  { fee: 3_000, tick: 60, label: '0.30%' },
  { fee: 10_000, tick: 200, label: '1.00%' },
]

function newRow(partial: Partial<BasketRow> & { id: string; symbol: string }): BasketRow {
  return {
    address: '',
    weightBps: 0,
    fee: BUNDLE_DEFAULT_FEE,
    tickSpacing: BUNDLE_DEFAULT_TICK_SPACING,
    hooks: '',
    ...partial,
  }
}

export function BundleBasketCard({
  enabled,
  onEnabled,
  mode,
  onMode,
  rows,
  onRows,
  quoteId,
  quoteSymbol,
  quoteAddress,
  preview = false,
}: {
  enabled: boolean
  onEnabled: (on: boolean) => void
  mode: BundlePayoutMode
  onMode: (mode: BundlePayoutMode) => void
  rows: BasketRow[]
  onRows: (rows: BasketRow[]) => void
  quoteId: string
  quoteSymbol: string
  quoteAddress: string
  preview?: boolean
}) {
  const catalog = catalogBasketOptions(listRwaAssets(), quoteId)
  const check = enabled
    ? basketValid(rows, { quote: (quoteAddress || '0x0000000000000000000000000000000000000000') as `0x${string}`, mode })
    : { ok: true, reason: null }

  const setWeights = (next: BasketRow[], weights: number[]) =>
    onRows(next.map((r, i) => ({ ...r, weightBps: weights[i] ?? 0 })))

  const toggleAsset = (a: ArcRwaAsset) => {
    const addr = (a.address || '').toLowerCase()
    const exists = rows.some((r) => r.id === a.id || r.address.toLowerCase() === addr)
    if (exists) {
      const next = rows.filter((r) => r.id !== a.id && r.address.toLowerCase() !== addr)
      setWeights(next, equalWeightsBps(next.length))
      return
    }
    if (!addr || addr === '0x0000000000000000000000000000000000000000') return
    const next = [
      ...rows,
      newRow({ id: a.id, symbol: a.symbol, address: a.address as string }),
    ]
    setWeights(next, equalWeightsBps(next.length))
  }

  const addCustom = () => {
    const next = [...rows, newRow({ id: `custom-${Date.now()}`, symbol: 'Custom' })]
    setWeights(next, equalWeightsBps(next.length))
  }

  const updateRow = (id: string, patch: Partial<BasketRow>) => {
    onRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const removeRow = (id: string) => {
    const next = rows.filter((r) => r.id !== id)
    setWeights(next, equalWeightsBps(next.length))
  }

  const selectedIds = new Set(rows.map((r) => r.id))

  return (
    <div className="rounded-2xl bg-s1 border border-hair p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Holder basket</div>
          <p className="mt-1 mb-0 text-xs text-t2 leading-snug">
            Quote-side fees convert into these assets. Holders claim the basket, never raw{' '}
            {quoteSymbol}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onEnabled(!enabled)}
          className="shrink-0 w-[52px] h-8 rounded-full p-0.5 flex transition-[background] duration-200"
          style={{
            background: enabled ? 'var(--lime)' : 'rgba(255,255,255,0.14)',
            justifyContent: enabled ? 'flex-end' : 'flex-start',
          }}
          aria-pressed={enabled}
          aria-label="Holders earn a basket"
        >
          <span className="w-7 h-7 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]" />
        </button>
      </div>

      {preview && enabled ? (
        <p className="mt-3 mb-0 text-[11px] leading-snug text-t3">
          Preview until the RWA v4 factory is set. This launch still uses the live Instant path.
        </p>
      ) : null}

      {enabled ? (
        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-2 text-[12px] text-t3">Payout</div>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-s2 border border-hair">
              {(
                [
                  ['all', 'All at once', 'Each convert splits by weight'],
                  ['rotate', 'Rotate', 'One asset per convert, cycling'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onMode(key)}
                  className={`h-9 rounded-xl text-[13px] font-semibold transition-colors ${
                    mode === key
                      ? 'bg-lime text-white'
                      : 'border border-transparent text-t2 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[12px] text-t3">Assets in the basket</div>
            <div className="flex flex-wrap gap-1.5">
              {catalog.map((a) => {
                const ready = Boolean(a.address && a.address !== '0x0000000000000000000000000000000000000000')
                const on = selectedIds.has(a.id)
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!ready}
                    onClick={() => toggleAsset(a)}
                    className={`h-8 px-3 rounded-full text-[12px] font-semibold transition-colors ${
                      !ready
                        ? 'opacity-35 cursor-not-allowed text-t3 border border-transparent'
                        : on
                          ? 'bg-lime text-white'
                          : 'border border-hair text-t2 hover:text-white hover:border-lime-line bg-white/[0.03]'
                    }`}
                  >
                    {a.symbol}
                    {!ready ? ' · soon' : ''}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={addCustom}
                className="h-8 px-3 rounded-full text-[12px] font-semibold border border-hair text-t2 hover:text-white hover:border-lime-line bg-white/[0.03]"
              >
                Custom
              </button>
            </div>
          </div>

          {rows.length > 0 ? (
            <div className="space-y-3">
              {rows.map((row) => (
                <div key={row.id} className="rounded-2xl border border-hair2 bg-s2/60 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold min-w-[3.5rem]">{row.symbol}</span>
                    <input
                      value={row.address}
                      onChange={(e) => updateRow(row.id, { address: e.target.value.trim() })}
                      placeholder="0x… basket token"
                      spellCheck={false}
                      className="flex-1 min-w-0 h-9 rounded-xl bg-s1 px-3 text-[12px] font-mono outline-none border border-hair focus:border-lime-line placeholder:text-white/30"
                    />
                    {mode === 'all' ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={Math.round(row.weightBps / 100)}
                          onChange={(e) =>
                            updateRow(row.id, { weightBps: Math.max(0, Number(e.target.value) || 0) * 100 })
                          }
                          className="w-14 h-9 rounded-xl bg-s1 border border-hair text-right text-[13px] font-semibold tabular-nums px-2 outline-none focus:border-lime-line"
                          aria-label={`${row.symbol} weight`}
                        />
                        <span className="text-[12px] text-t3">%</span>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="h-9 px-2 rounded-xl text-[12px] text-t3 hover:text-coral"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-t3">Convert pool vs {quoteSymbol}</span>
                    {FEE_TIERS.map((t) => (
                      <button
                        key={t.fee}
                        type="button"
                        onClick={() => updateRow(row.id, { fee: t.fee, tickSpacing: t.tick })}
                        className={`h-7 px-2 rounded-full text-[11px] font-semibold ${
                          row.fee === t.fee
                            ? 'bg-lime text-white'
                            : 'border border-hair text-t2 hover:text-white'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {row.address && isAddress(row.address) ? (
                    <p className="mt-1.5 mb-0 text-[11px] text-t3 font-mono truncate">
                      {row.address.slice(0, 6)}…{row.address.slice(-4)} · fee {row.fee} · tick {row.tickSpacing}
                    </p>
                  ) : null}
                </div>
              ))}
              {mode === 'all' ? (
                <p className="m-0 text-[12px] text-t3 tabular-nums">
                  Allocated {(basketWeightSum(rows) / 100).toFixed(0)}% of 100%
                </p>
              ) : (
                <p className="m-0 text-[12px] text-t3">
                  Each convert sends the full pulled amount to the next asset in this list.
                </p>
              )}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-t3">Pick at least one asset holders should earn.</p>
          )}

          <div
            className={`rounded-2xl px-3.5 py-2.5 text-[12px] leading-snug ${
              check.ok
                ? 'bg-fun/10 text-fun border border-fun/25'
                : 'bg-coral/10 text-coral border border-coral/25'
            }`}
          >
            {check.ok
              ? 'Basket is ready. Launch then signs setBasket from this wallet.'
              : check.reason}
          </div>
        </div>
      ) : (
        <p className="mt-3 mb-0 text-[12px] text-t3 leading-snug">
          Off: this RWA pair does not pay holders (permissioned quote stays out of random wallets).
        </p>
      )}
    </div>
  )
}
