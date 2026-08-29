/**
 * Image uploads now go through Vercel Blob (`lib/upload-image.ts` → POST /api/upload).
 *
 * Existing res.cloudinary.com URLs (ifmywgoj and the retired dtgdfntom cloud) stay
 * in token/collection metadata and keep rendering. Do not rewrite them.
 */
export { uploadImage, uploadImageToCloudinary } from './upload-image'
