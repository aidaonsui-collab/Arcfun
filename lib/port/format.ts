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

export function timeAgo(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
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
