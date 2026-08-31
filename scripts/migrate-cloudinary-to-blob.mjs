/**
 * Copy live Cloudinary images to Vercel Blob and rewrite KV URLs.
 *
 * Already applied on production 2026-08-31 (123 files, Eve collection + token
 * pfps + one creator avatar). Keep this for a rerun if a leftover Cloudinary
 * URL shows up in KV, or to dry-run a scan.
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-cloudinary-to-blob.mjs --dry-run
 *   BLOB_READ_WRITE_TOKEN=... node --env-file=.env.local scripts/migrate-cloudinary-to-blob.mjs
 *
 * Needs KV_REST_API_URL + KV_REST_API_TOKEN. APPLY also needs BLOB_READ_WRITE_TOKEN
 * (production Blob store). Writes a KV backup to /tmp/cloudinary-kv-backup.json
 * before any SET.
 */
import { writeFileSync } from 'node:fs'
import { put } from '@vercel/blob'

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '')
const KV_TOKEN = process.env.KV_REST_API_TOKEN
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN
const DRY = process.argv.includes('--dry-run')

const CLOUD = /res\.cloudinary\.com/i
const URL_RE = /https?:\/\/res\.cloudinary\.com\/[^\s"'\\]+/g

async function redis(...args) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`redis ${args[0]} ${r.status} ${JSON.stringify(j).slice(0, 300)}`)
  return j.result
}

function stripTransform(url) {
  return url.replace(
    /\/image\/upload\/(?:(?:f_|q_|w_|h_|c_|dpr_|e_|g_|fl_)[^/]+\/)+/i,
    '/image/upload/',
  )
}

function pathnameFor(url) {
  const u = new URL(stripTransform(url))
  const parts = u.pathname.split('/').filter(Boolean)
  const upload = parts.indexOf('upload')
  const after = upload >= 0 ? parts.slice(upload + 1) : parts.slice(-2)
  const cleaned = after.filter((p) => !/^v\d+$/.test(p)).join('/')
  return `migrated/${cleaned || 'image'}`
}

function collectUrls(s) {
  const out = new Set()
  for (const m of s.matchAll(URL_RE)) out.add(stripTransform(m[0].replace(/[},\]]+$/, '')))
  return [...out]
}

function replaceUrls(value, map) {
  if (typeof value === 'string') {
    let next = value
    for (const [from, to] of map) next = next.split(from).join(to)
    return next
  }
  if (Array.isArray(value)) return value.map((v) => replaceUrls(v, map))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = replaceUrls(v, map)
    return out
  }
  return value
}

async function pool(items, n, fn) {
  const ret = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      ret[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return ret
}

async function main() {
  if (!KV_URL || !KV_TOKEN) throw new Error('missing KV_REST_API_URL / KV_REST_API_TOKEN')
  if (!DRY && !BLOB_TOKEN) throw new Error('missing BLOB_READ_WRITE_TOKEN')

  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await redis('SCAN', cursor, 'COUNT', 200)
    cursor = String(next)
    keys.push(...batch)
  } while (cursor !== '0')

  const affected = []
  const unique = new Set()
  for (let i = 0; i < keys.length; i += 40) {
    const group = keys.slice(i, i + 40)
    const vals = await redis('MGET', ...group)
    for (let j = 0; j < group.length; j++) {
      const raw = vals[j]
      if (raw == null) continue
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
      if (!CLOUD.test(s)) continue
      const urls = collectUrls(s)
      urls.forEach((u) => unique.add(u))
      affected.push({ key: group[j], raw, urls })
    }
  }

  console.log(DRY ? 'DRY RUN' : 'APPLY')
  console.log('keys scanned', keys.length)
  console.log('keys with cloudinary', affected.length)
  console.log('unique urls', unique.size)
  affected.forEach((a) => console.log(' ', a.key, a.urls.length))

  const backup = Object.fromEntries(affected.map((a) => [a.key, a.raw]))
  writeFileSync('/tmp/cloudinary-kv-backup.json', JSON.stringify(backup))
  console.log('backup /tmp/cloudinary-kv-backup.json')

  if (DRY) return

  const urls = [...unique]
  const map = new Map()
  const missing = []
  let bytes = 0
  function persistMap() {
    writeFileSync('/tmp/cloudinary-to-blob-map.json', JSON.stringify(Object.fromEntries(map), null, 2))
  }
  await pool(urls, 4, async (src, idx) => {
    const res = await fetch(src)
    if (!res.ok) {
      missing.push({ src, status: res.status })
      console.warn(`[${idx + 1}/${urls.length}] SKIP ${res.status} ${src}`)
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    bytes += buf.length
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
    const blob = await put(pathnameFor(src), buf, {
      access: 'public',
      token: BLOB_TOKEN,
      addRandomSuffix: true,
      contentType: type,
      multipart: buf.length > 4 * 1024 * 1024,
    })
    if (!blob.url) throw new Error(`put returned no url for ${src}`)
    map.set(src, blob.url)
    persistMap()
    console.log(`[${idx + 1}/${urls.length}] ${buf.length} ${src.split('/').slice(-2).join('/')} -> ${blob.url}`)
  })

  persistMap()
  console.log('uploaded', map.size, 'files', `${(bytes / 1024 / 1024).toFixed(1)}MB`)
  if (missing.length) {
    console.warn('missing on cloudinary', missing.length)
    missing.forEach((m) => console.warn(' ', m.status, m.src))
  }

  let rewritten = 0
  for (const row of affected) {
    const parsed = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw
    const next = replaceUrls(parsed, map)
    const encoded = JSON.stringify(next)
    if (encoded === (typeof row.raw === 'string' ? row.raw : JSON.stringify(row.raw))) {
      console.warn('no change', row.key)
      continue
    }
    const leftover = collectUrls(encoded)
    if (leftover.length) {
      console.warn('leftover cloudinary (already 404 or unmapped)', row.key, leftover.length)
    }
    await redis('SET', row.key, encoded)
    rewritten++
    console.log('rewrote', row.key)
  }

  console.log('rewritten keys', rewritten)
  console.log('map /tmp/cloudinary-to-blob-map.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
