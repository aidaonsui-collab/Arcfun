/** Shared display helpers for Arc OTC. */

export function fmtUsdc(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}

export function fmtRobin(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.floor(n).toLocaleString('en-US')
}

export function shortAddr(a: string | undefined | null): string {
  if (!a || a.length < 10) return '—'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
