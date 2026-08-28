/**
 * Token art from tweet media only. Never an X profile picture.
 */

export type TweetMediaPiece = {
  type?: string
  url?: string
  preview_image_url?: string
}

export type TweetRef = { type: string; id: string }

function httpsUrl(raw: string | undefined): string | null {
  const u = (raw || '').trim()
  return u.startsWith('https://') ? u : null
}

/** First photo/gif URL from tweet media. Video falls back to its preview. */
export function firstTweetPhoto(
  media: Iterable<TweetMediaPiece | undefined> | null | undefined,
): string | null {
  if (!media) return null
  let fallback: string | null = null
  for (const m of media) {
    const url = httpsUrl(m?.url) || httpsUrl(m?.preview_image_url)
    if (!url) continue
    const type = (m?.type || '').toLowerCase()
    if (type === 'photo' || type === 'animated_gif' || !type) return url
    if (!fallback) fallback = url
  }
  return fallback
}

export function firstTweetPhotoFromKeys(
  keys: string[] | undefined,
  mediaByKey: { get(key: string): TweetMediaPiece | undefined },
): string | null {
  if (!keys?.length) return null
  const pieces: TweetMediaPiece[] = []
  for (const k of keys) {
    const m = mediaByKey.get(k)
    if (m) pieces.push(m)
  }
  return firstTweetPhoto(pieces)
}

/** Reply parent first, then quoted tweet. Retweets are ignored. */
export function parentTweetId(refs: TweetRef[] | undefined): string | null {
  if (!refs?.length) return null
  const reply = refs.find((r) => r.type === 'replied_to')
  if (reply?.id) return reply.id
  const quoted = refs.find((r) => r.type === 'quoted')
  if (quoted?.id) return quoted.id
  return null
}

/** Canonical x.com status URL. Handle is optional (`/i/status/id` still opens the post). */
export function tweetStatusUrl(handle: string | undefined, id: string): string | null {
  const snowflake = (id || '').trim()
  if (!/^\d{10,22}$/.test(snowflake)) return null
  const h = (handle || '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
  return h ? `https://x.com/${h}/status/${snowflake}` : `https://x.com/i/status/${snowflake}`
}

export function blitzTokenImageUrl(imageUrl: string | null | undefined): string | undefined {
  const u = httpsUrl(imageUrl || undefined)
  if (!u) return undefined
  // pbs profile_images / profile_banners are X pfps, not tweet art.
  if (/\/profile_images\//i.test(u) || /\/profile_banners\//i.test(u)) return undefined
  return u
}
