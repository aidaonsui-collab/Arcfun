/**
 * Resize images at delivery time instead of shipping whatever the creator uploaded.
 *
 * Found 2026-08-29 on the live home grid: token logos were served at full original resolution
 * into ~48-96px avatars. One PNG was 2,244,916 bytes; images alone were 6,181 KB of a 6,832 KB
 * page, against 31 KB on a comparable competitor. TTFB was already fine (140ms) — the payload
 * was the whole problem.
 *
 * Two hosts are in play and they need different treatment:
 *   - res.cloudinary.com — leftover legacy URLs. Transformations are URL segments.
 *     Live copies were moved to Blob (see scripts/migrate-cloudinary-to-blob.mjs).
 *   - *.public.blob.vercel-storage.com — where uploads go. Blob has no transform API, so
 *     these route through Next's own optimizer, which is allow-listed for both hosts in
 *     next.config.js.
 *
 * Anything else — data:, blob:, relative paths, unknown hosts — is returned untouched. Local
 * file previews in the upload widgets must never be rewritten.
 */

/** Rendered CSS pixels. The helper doubles it for retina. */
export type ImgSize = number

const CLOUDINARY_RE = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(.+)$/i
const BLOB_RE = /^https?:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//i

/** Cloudinary segments we inject. Anything already carrying transforms is left alone. */
const TRANSFORM_HINT = /(^|\/)(f_|q_|w_|h_|c_|dpr_|e_|g_)/

function cloudinaryTransform(url: string, size: ImgSize, fit: 'fill' | 'fit'): string | null {
  const m = url.match(CLOUDINARY_RE)
  if (!m) return null
  const [, cloud, rest] = m
  // `rest` is everything after /upload/ — either `v123/folder/id.png` or an existing
  // transform chain. Re-transforming a transformed URL stacks segments and can produce
  // surprising crops, so bail if it already looks transformed.
  if (TRANSFORM_HINT.test(rest.split('/')[0] || '')) return url
  const px = Math.round(size)
  const t = `f_auto,q_auto,w_${px},h_${px},c_${fit === 'fill' ? 'fill' : 'fit'},dpr_2.0`
  return `https://res.cloudinary.com/${cloud}/image/upload/${t}/${rest}`
}

function nextOptimized(url: string, size: ImgSize): string {
  // Next's optimizer only accepts widths from its configured deviceSizes/imageSizes ladder;
  // rounding up to a standard step avoids a 400 on an arbitrary width.
  const ladder = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920]
  const want = Math.round(size * 2)
  const w = ladder.find((v) => v >= want) ?? ladder[ladder.length - 1]
  return `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=75`
}

/**
 * Delivery URL for `url` rendered at roughly `size` CSS pixels.
 * Returns the input unchanged when it cannot be optimized safely.
 */
export function cdnImage(
  url: string | null | undefined,
  size: ImgSize = 128,
  fit: 'fill' | 'fit' = 'fill',
): string {
  if (!url) return ''
  const u = url.trim()
  if (!u) return ''
  // Local previews and inline data must pass through untouched.
  if (u.startsWith('data:') || u.startsWith('blob:')) return u
  if (!/^https?:\/\//i.test(u)) return u

  const cloudinary = cloudinaryTransform(u, size, fit)
  if (cloudinary) return cloudinary
  if (BLOB_RE.test(u)) return nextOptimized(u, size)
  return u
}
