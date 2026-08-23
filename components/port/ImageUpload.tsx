'use client'

import { useRef, useState, type DragEvent } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/cn'

export function ImageUpload({
  value,
  onChange,
  label = 'Collection image',
  hint = '1000 × 1000 · JPG, PNG, WEBP',
  variant = 'tile',
}: {
  value: string
  onChange: (src: string, file?: File) => void
  label?: string
  hint?: string
  variant?: 'tile' | 'hero'
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')
  const [over, setOver] = useState(false)
  const hero = variant === 'hero'

  function onFile(file?: File) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErr('Use a PNG or JPG')
      return
    }
    const src = URL.createObjectURL(file)
    onChange(src, file)
    setErr('')
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    onFile(e.dataTransfer.files?.[0])
  }

  return (
    <div className={hero ? 'flex h-full min-h-[280px] flex-col' : ''}>
      <span className="mb-2 block text-[13px] font-medium text-t2">{label}</span>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'relative overflow-hidden rounded-[20px] border border-dashed text-t3 transition-colors',
          hero
            ? 'flex min-h-[280px] flex-1 w-full items-center justify-center bg-s1 sm:min-h-[420px]'
            : 'flex aspect-square w-full max-w-[220px] items-center justify-center bg-s2',
          over ? 'border-lime-line bg-s2' : 'border-hair hover:border-lime-line',
        )}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-3 px-6 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl border border-hair bg-s2">
              <Upload className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <span className="text-[15px]">
              <span className="font-semibold text-lime-t">Click to upload</span>
              <span className="text-t2"> or drag and drop</span>
            </span>
            <span className="text-[13px] text-t3">{hint}</span>
          </span>
        )}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {err ? <p className="mt-1.5 text-[13px] text-coral">{err}</p> : null}
    </div>
  )
}
