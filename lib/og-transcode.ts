/**
 * Raster → PNG for next/og. satori cannot decode webp/avif.
 * Used from the /api/og-raster Node function (not the OG image bundle).
 */
import sharp from 'sharp'

export async function rasterToPng(
  buf: Buffer,
  width: number,
  height: number,
): Promise<Buffer | null> {
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
    return png
  } catch (e) {
    console.error('[og-transcode]', e)
    return null
  }
}

export async function rasterToPngDataUri(
  buf: Buffer,
  width: number,
  height: number,
): Promise<string | null> {
  const png = await rasterToPng(buf, width, height)
  return png ? `data:image/png;base64,${png.toString('base64')}` : null
}
