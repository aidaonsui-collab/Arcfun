/**
 * Social / image URL sanitizers. Display hrefs are always https and host-bound.
 * Never pass creator-supplied strings straight into <a href>.
 */
export function sanitizeHttpsUrl(raw: string, max = 512): string {
  const t = raw.trim()
  if (!t || t.length > max) return ''
  if (!/^https:\/\//i.test(t) || /\s/.test(t)) return ''
  try {
    const u = new URL(t)
    if (u.protocol !== 'https:') return ''
    if (!u.hostname) return ''
    return t.slice(0, max)
  } catch {
    return ''
  }
}

export function sanitizeTwitter(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      if (u.protocol !== 'https:') return ''
      const host = u.hostname.replace(/^www\./i, '').toLowerCase()
      if (host !== 'x.com' && host !== 'twitter.com') return ''
      const handle = (u.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '')
      return /^[A-Za-z0-9_]{1,32}$/.test(handle) ? handle : ''
    } catch {
      return ''
    }
  }
  const handle = t.replace(/^@/, '').split(/[/?#]/)[0]
  return /^[A-Za-z0-9_]{1,32}$/.test(handle) ? handle : ''
}

export function sanitizeTelegram(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      if (u.protocol !== 'https:') return ''
      const host = u.hostname.replace(/^www\./i, '').toLowerCase()
      if (host !== 't.me' && host !== 'telegram.me') return ''
      const path = (u.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '')
      return /^[A-Za-z0-9_]{3,32}$/.test(path) ? path : ''
    } catch {
      return ''
    }
  }
  const path = t.replace(/^(t\.me|telegram\.me)\//i, '').replace(/^@/, '').split(/[/?#]/)[0]
  return /^[A-Za-z0-9_]{3,32}$/.test(path) ? path : ''
}

export function sanitizeWebsite(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  const url = /^https:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return ''
    if (!u.hostname || !u.hostname.includes('.')) return ''
    if (u.username || u.password) return ''
    return u.href.slice(0, 200)
  } catch {
    return ''
  }
}

export function twitterHref(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 'x.com' || host === 'twitter.com') {
      const parts = u.pathname.split('/').filter(Boolean)
      const statusAt = parts.findIndex((p) => p.toLowerCase() === 'status')
      if (statusAt >= 0 && parts[statusAt + 1] && /^\d{10,22}$/.test(parts[statusAt + 1].split(/[?#]/)[0])) {
        const id = parts[statusAt + 1].split(/[?#]/)[0]
        const handle = (parts[0] && parts[0].toLowerCase() !== 'i' && parts[0].toLowerCase() !== 'status'
          ? parts[0]
          : ''
        ).replace(/^@/, '')
        return /^[A-Za-z0-9_]{1,32}$/.test(handle)
          ? `https://x.com/${handle}/status/${id}`
          : `https://x.com/i/status/${id}`
      }
    }
  } catch {
    /* handle path */
  }
  const handle = sanitizeTwitter(t)
  return handle ? `https://x.com/${handle}` : ''
}

export function telegramHref(raw: string): string {
  const path = sanitizeTelegram(raw)
  return path ? `https://t.me/${path}` : ''
}

export function websiteHref(raw: string): string {
  return sanitizeWebsite(raw)
}
