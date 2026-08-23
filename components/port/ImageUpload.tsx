'use client'

import { useRef, useState } from 'react'

export function ImageUpload({
  value,
  onChange,
  label = 'Image',
  hint = 'PNG or JPG. Square crops best.',
}: {
  value: string
  onChange: (src: string, file?: File) => void
  label?: string
  hint?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')

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

  return (
    <div>
      <span className="mb-2 block text-[13px] font-medium text-t2">{label}</span>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="relative flex aspect-square w-full max-w-[220px] items-center justify-center overflow-hidden rounded-[24px] border border-dashed border-hair bg-s2 text-t3 hover:border-lime-line"
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-[13px] font-medium">Upload</span>
        )}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <p className="mt-1.5 text-[13px] text-t3">{err || hint}</p>
    </div>
  )
}
