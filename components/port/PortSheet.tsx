'use client'

import type { ReactNode } from 'react'

export function PortSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(10,15,24,0.7)]"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[28px] bg-s1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] animate-[sheetUp_0.28s_ease-out]">
        <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-hair" />
        {title ? (
          <h2 className="px-5 pb-2 pt-4 text-[17px] font-semibold tracking-tightish">{title}</h2>
        ) : null}
        <div className="overflow-y-auto px-5 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2">
          {children}
        </div>
      </div>
    </div>
  )
}
