/**
 * Browser helper: POST an image to /api/upload (Vercel Blob).
 * Returns the public delivery URL. Throws on failure.
 *
 * Uploads go to the public `arcfun-images` Blob store.
 */
export async function uploadImage(file: File, folder = 'arcfun'): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('folder', folder)
  const res = await fetch('/api/upload', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `upload failed: ${res.status}`)
  }
  const data = (await res.json()) as { url?: string }
  if (!data.url) throw new Error('upload returned no URL')
  return data.url
}

/** @deprecated use uploadImage — same helper, old name kept for call sites. */
export const uploadImageToCloudinary = uploadImage
