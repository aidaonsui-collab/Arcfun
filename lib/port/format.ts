export function shortAddr(address: string) {
  if (!address || address.length < 12) return address || ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatUsdc(value: number, digits = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: value % 1 === 0 && digits === 2 ? 0 : Math.min(digits, 2),
    maximumFractionDigits: digits,
  })
}

export function formatInt(value: number) {
  return value.toLocaleString('en-US')
}

export function timeUntil(ts: number) {
  const s = Math.max(0, Math.floor((ts - Date.now()) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  if (d > 0) return `${d}d ${h}h`
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
