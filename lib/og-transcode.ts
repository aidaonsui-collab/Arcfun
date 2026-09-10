/**
 * Raster → PNG data URI for next/og. satori cannot decode webp/avif.
 * Keep sharp external (see next.config serverExternalPackages) so native
 * binaries are not lost in the OG serverless bundle.
 */
import sharp from 'sharp'

export async function rasterToPngDataUri(
  buf: Buffer,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    const png = await sharp(buf)
      .rotate()
      .resize(width, height, { fit: 'cover' })
      .png()
      .toBuffer()
    if (png.length < 32 || png.length > 6_000_000) {
      console.error('[og-transcode] png size out of range', png.length)
      return null
    }
    return `data:image/png;base64,${png.toString('base64')}`
  } catch (e) {
    console.error('[og-transcode]', e)
    return null
  }
}
