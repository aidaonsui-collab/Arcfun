// Centralized Cloudinary config + browser upload helper.
//
// UPLOADS go to the `ifmywgoj` cloud via the unsigned preset `launchpad`. This is the ONE place the
// cloud name lives — every create/edit flow imports from here (previously each hardcoded the cloud,
// and when the old `dtgdfntom` cloud was lost every upload failed silently). See
// reference: the retired `dtgdfntom` cloud still serves EXISTING images via their
// res.cloudinary.com/dtgdfntom/... delivery URLs; those are unmanaged and unaffected by this module.

export const CLOUDINARY_CLOUD = 'ifmywgoj'
export const CLOUDINARY_UPLOAD_PRESET = 'launchpad'
export const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`

/**
 * Unsigned browser upload of an image file. Returns the secure delivery URL.
 * THROWS on any failure (bad preset, network, no URL) — callers decide whether to surface the error
 * to the user or swallow it. `folder` defaults to the launchpad bucket (chat uploads pass 'chat').
 */
export async function uploadImageToCloudinary(
  file: File,
  folder: string = CLOUDINARY_UPLOAD_PRESET,
): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET)
  fd.append('folder', folder)
  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status}`)
  const data = (await res.json()) as { secure_url?: string }
  if (!data.secure_url) throw new Error('Cloudinary upload returned no URL')
  return data.secure_url
}
