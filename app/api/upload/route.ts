/**
 * POST /api/upload — store a public image in Vercel Blob.
 * Browser create/edit flows send the file here (Blob writes cannot be unsigned).
 * Legacy Cloudinary URLs in metadata were migrated to this store.
 */
import { put } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'
import { limitOr429 } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_BYTES = 4 * 1024 * 1024
const FOLDERS = new Set([
  'arcfun',
  'port',
  'port-items',
  'creator-avatars',
  'chat',
  'launchpad',
])
const TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'])

function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() || 'image'
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  return cleaned || 'image'
}

export async function POST(req: NextRequest) {
  const limited = await limitOr429(req, 'upload', 12, 60)
  if (limited) return limited

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'invalid form' }, { status: 400 })

  const file = form.get('file')
  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'no file' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'image too large (max 4mb)' }, { status: 413 })
  }
  const type = (file.type || '').toLowerCase()
  if (type && !TYPES.has(type)) {
    return NextResponse.json({ error: 'unsupported image type' }, { status: 415 })
  }

  const folderRaw = String(form.get('folder') || 'arcfun').trim().toLowerCase()
  const folder = FOLDERS.has(folderRaw) ? folderRaw : 'arcfun'
  const pathname = `${folder}/${safeName(file.name)}`

  try {
    const blob = await put(pathname, file, {
      access: 'public',
      addRandomSuffix: true,
      contentType: TYPES.has(type) ? type : 'image/jpeg',
    })
    if (!blob.url) return NextResponse.json({ error: 'upload returned no URL' }, { status: 502 })
    return NextResponse.json({ url: blob.url })
  } catch (e) {
    console.error('[upload]', e instanceof Error ? e.message : 'failed')
    return NextResponse.json({ error: 'upload failed' }, { status: 502 })
  }
}
