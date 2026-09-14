/**
 * V4 Instant fee split — one pool fee (0.3–3%), 100% allocation across
 * creator / burn / holders / auto-LP / platform. Matches EveFeeHook.
 */

export const FEE_BPS_DENOM = 10_000
export const MIN_FEE_BPS = 30
export const MAX_FEE_BPS = 300
export const MIN_PLATFORM_BPS = 1_000
export const MIN_REFLECT_HOLDERS_BPS = 2_000

export type FeeSplitId = 'creator' | 'reflect' | 'scorched' | 'pool' | 'custom'

export type FeeSplit = {
  feeBps: number
  creatorBps: number
  burnBps: number
  holdersBps: number
  autoLpBps: number
  platformBps: number
}

export type FeeLeg = 'creator' | 'burn' | 'holders' | 'autoLp' | 'platform'

export const FEE_LEGS: {
  key: FeeLeg
  label: string
  hint: string
  color: string
}[] = [
  { key: 'creator', label: 'Creator', hint: 'Wallet or X-handle vault', color: '#2f84db' },
  { key: 'burn', label: 'Burn', hint: 'Launch token to dead', color: '#ff7a62' },
  { key: 'holders', label: 'Holders', hint: 'Per-token sink', color: '#7cff3a' },
  { key: 'autoLp', label: 'Auto-LP', hint: 'Stays in the pool', color: '#7ec0f7' },
  { key: 'platform', label: 'eve.fun', hint: '10% floor', color: '#8b9bb4' },
]

export const FEE_SPLIT_PRESETS: Record<Exclude<FeeSplitId, 'custom'>, FeeSplit> = {
  creator: {
    feeBps: 100,
    creatorBps: 7_000,
    burnBps: 1_000,
    holdersBps: 0,
    autoLpBps: 1_000,
    platformBps: 1_000,
  },
  reflect: {
    feeBps: 100,
    creatorBps: 2_000,
    burnBps: 1_000,
    holdersBps: 5_000,
    autoLpBps: 1_000,
    platformBps: 1_000,
  },
  scorched: {
    feeBps: 100,
    creatorBps: 2_000,
    burnBps: 6_000,
    holdersBps: 0,
    autoLpBps: 1_000,
    platformBps: 1_000,
  },
  pool: {
    feeBps: 100,
    creatorBps: 2_000,
    burnBps: 1_000,
    holdersBps: 0,
    autoLpBps: 6_000,
    platformBps: 1_000,
  },
}

export const FEE_PRESET_META: Record<
  FeeSplitId,
  { title: string; body: string }
> = {
  creator: { title: 'Creator', body: 'Most of the fee goes to you.' },
  reflect: { title: 'Reflect', body: 'Holders take the largest slice.' },
  scorched: { title: 'Scorched', body: 'Most of the fee burns the launch token.' },
  pool: { title: 'Pool', body: 'Most of the fee stays as LP.' },
  custom: { title: 'Custom', body: 'Set every slice yourself.' },
}

export function bpsKey(leg: FeeLeg): keyof FeeSplit {
  switch (leg) {
    case 'creator':
      return 'creatorBps'
    case 'burn':
      return 'burnBps'
    case 'holders':
      return 'holdersBps'
    case 'autoLp':
      return 'autoLpBps'
    case 'platform':
      return 'platformBps'
  }
}

export function splitSum(s: FeeSplit): number {
  return s.creatorBps + s.burnBps + s.holdersBps + s.autoLpBps + s.platformBps
}

export function splitRemaining(s: FeeSplit): number {
  return FEE_BPS_DENOM - splitSum(s)
}

export function pctLabel(bps: number): string {
  const pct = bps / 100
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`
}

export function feePctLabel(feeBps: number): string {
  const pct = feeBps / 100
  return `${pct.toFixed(1)}%`
}

export function matchPreset(s: FeeSplit): FeeSplitId {
  for (const id of ['creator', 'reflect', 'scorched', 'pool'] as const) {
    const p = FEE_SPLIT_PRESETS[id]
    if (
      s.feeBps === p.feeBps &&
      s.creatorBps === p.creatorBps &&
      s.burnBps === p.burnBps &&
      s.holdersBps === p.holdersBps &&
      s.autoLpBps === p.autoLpBps &&
      s.platformBps === p.platformBps
    ) {
      return id
    }
  }
  return 'custom'
}

export function foldHoldersIntoCreator(s: FeeSplit): FeeSplit {
  if (s.holdersBps === 0) return s
  return { ...s, creatorBps: s.creatorBps + s.holdersBps, holdersBps: 0 }
}

export function splitValid(
  s: FeeSplit,
  opts: { minHoldersBps?: number; hideHolders?: boolean } = {},
): { ok: boolean; reason: string | null } {
  if (s.feeBps < MIN_FEE_BPS || s.feeBps > MAX_FEE_BPS) {
    return { ok: false, reason: 'Pool fee must be between 0.3% and 3%.' }
  }
  if (s.platformBps < MIN_PLATFORM_BPS) {
    return { ok: false, reason: 'eve.fun takes at least 10%.' }
  }
  if (opts.hideHolders && s.holdersBps > 0) {
    return { ok: false, reason: 'This quote does not pay holders.' }
  }
  const minH = opts.minHoldersBps ?? 0
  if (minH > 0 && s.holdersBps < minH) {
    return { ok: false, reason: `Reflect needs holders at ${pctLabel(minH)} or more.` }
  }
  const sum = splitSum(s)
  if (sum !== FEE_BPS_DENOM) {
    const rem = FEE_BPS_DENOM - sum
    return {
      ok: false,
      reason: rem > 0 ? `Allocate the remaining ${pctLabel(rem)}.` : `Over by ${pctLabel(-rem)}.`,
    }
  }
  for (const leg of FEE_LEGS) {
    const v = s[bpsKey(leg.key)]
    if (v < 0 || v > FEE_BPS_DENOM) return { ok: false, reason: 'Each slice must be 0–100%.' }
  }
  return { ok: true, reason: null }
}

export function conicStops(s: FeeSplit, hideHolders = false): string {
  const legs = hideHolders ? FEE_LEGS.filter((l) => l.key !== 'holders') : FEE_LEGS
  const total = legs.reduce((n, l) => n + s[bpsKey(l.key)], 0)
  if (total <= 0) return '#1a1f2a 0 100%'
  let acc = 0
  const parts: string[] = []
  for (const l of legs) {
    const pct = (s[bpsKey(l.key)] / total) * 100
    if (pct <= 0) continue
    parts.push(`${l.color} ${acc}% ${acc + pct}%`)
    acc += pct
  }
  if (acc < 100) parts.push(`#1a1f2a ${acc}% 100%`)
  return parts.join(', ')
}
