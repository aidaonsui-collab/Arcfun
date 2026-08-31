/**
 * Image uploads go through Vercel Blob (`lib/upload-image.ts` → POST /api/upload).
 *
 * Live res.cloudinary.com URLs (ifmywgoj and the retired dtgdfntom cloud) were
 * copied to Blob and rewritten in KV on 2026-08-31. `cdnImage` still knows how
 * to transform a leftover Cloudinary URL if one shows up. To re-scan KV:
 * `node --env-file=.env.local scripts/migrate-cloudinary-to-blob.mjs --dry-run`.
 */
export { uploadImage, uploadImageToCloudinary } from './upload-image'
