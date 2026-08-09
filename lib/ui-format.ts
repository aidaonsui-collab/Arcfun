/**
 * Display helpers shared by Discover / token cards — market format, age, synthetic
 * sparklines, and deterministic gradient tiles (design handoff vocabulary).
 */

export function fmtUsd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '$0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (abs >= 1) return `$${n.toFixed(2)}`
  if (abs >= 0.0001) return `$${n.toFixed(4)}`
  return `$${n.toExponential(2)}`
}

export function fmtPrice(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '$0'
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(4)}`
  if (n >= 0.000001) return `$${n.toFixed(6)}`
  return `$${n.toExponential(2)}`
}

export function fmtCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 100) return n.toFixed(0)
  if (n >= 1) return n.toFixed(1)
  return n.toFixed(2)
}

/** Age label from unix seconds (createdAt). */
export function ageLabel(ts: number | undefined | null): string {
  if (!ts) return '—'
  // createdAt may be ms or s
  const sec = ts > 1e12 ? Math.floor(ts / 1000) : ts
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / 86400)}d`
}

export function shortAddr(addr: string | undefined | null): string {
  if (!addr || addr.length < 10) return addr || '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function changeParts(pct: number | undefined | null): {
  up: boolean
  label: string
  chipBg: string
  chipFg: string
  stroke: string
} {
  const n = pct ?? 0
  const up = n >= 0
  return {
    up,
    label: `${up ? '↑' : '↓'} ${Math.abs(n).toFixed(1)}%`,
    chipBg: up ? 'var(--lime)' : 'var(--coral)',
    chipFg: '#fff',
    stroke: up ? 'var(--limeT)' : 'var(--coral)',
  }
}

/** Deterministic HSL tile gradient from a seed string (address/symbol). */
export function tileGradient(seed: string): { tile: string; mono: string } {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const h1 = h % 360
  const h2 = (h1 + 40 + (h % 80)) % 360
  const l1 = 46 + (h % 18)
  const l2 = 28 + ((h >> 3) % 14)
  const tile = `linear-gradient(150deg, hsl(${h1} 78% ${l1}%), hsl(${h2} 70% ${l2}%))`
  const mono = l1 > 55 ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.88)'
  return { tile, mono }
}

/**
 * Synthetic sparkline path in a 100×30 viewBox, seeded by address + optional direction bias
 * from priceChange24h. Matches the design handoff `spark()` shape.
 */
export function sparkPath(seed: string, n = 26, bias = 0): string {
  let s = 7
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648
    out.push(s / 2147483648)
  }
  // Mild directional drift from 24h change so up tokens trend up.
  const drift = Math.max(-0.35, Math.min(0.35, bias / 100))
  const series = out.map((v, i) => v + drift * (i / (n - 1)))
  const sm = series.map((v, i) => {
    const a = series[i - 1] ?? v
    const b = series[i + 1] ?? v
    return (v + a + b) / 3
  })
  const min = Math.min(...sm)
  const max = Math.max(...sm)
  const span = max - min || 1
  return (
    'M ' +
    sm
      .map((v, i) => {
        const x = ((i / (n - 1)) * 100).toFixed(1)
        const y = (27 - ((v - min) / span) * 23).toFixed(1)
        return `${x} ${y}`
      })
      .join(' L ')
  )
}

export function walletHue(addr: string): string {
  let h = 0
  for (let i = 0; i < addr.length; i++) h = (h * 33 + addr.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 70% 55%)`
}
