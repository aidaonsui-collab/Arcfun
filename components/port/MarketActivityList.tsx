'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { MarketActivity } from '@/lib/port/market'
import { atomicToUsdc } from '@/lib/port/market'
import { fetchActivity } from '@/lib/port/listings'
import { formatUsdc, timeAgo } from '@/lib/port/format'

const POLL_MS = 10_000

const LABEL: Record<MarketActivity['type'], string> = {
  list: 'Listed',
  sale: 'Sold',
  cancel: 'Cancelled',
  offer: 'Offer',
  mint: 'Minted',
}

function activityKey(e: MarketActivity) {
  return `${e.orderHash}:${e.type}`
}

function mergeTape(a: MarketActivity[], b: MarketActivity[], limit: number) {
  const seen = new Set<string>()
  const out: MarketActivity[] = []
  for (const e of [...a, ...b].sort((x, y) => y.at - x.at)) {
    const k = activityKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

export function MarketActivityList({
  events,
  collection,
  names,
  slugs,
  empty = 'No activity yet',
  pollCollection,
  pollTokenId,
}: {
  events: MarketActivity[]
  collection?: string
  names?: Record<string, string>
  slugs?: Record<string, string>
  empty?: string
  /** Contract address to poll. Omit for the Studio-wide tape. */
  pollCollection?: string
  pollTokenId?: number | string
}) {
  const cap = pollCollection ? 100 : 40
  const [rows, setRows] = useState(events)

  useEffect(() => {
    setRows((cur) => mergeTape(events, cur, cap))
  }, [events, cap])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const ac = new AbortController()

    const pull = async () => {
      const next = await fetchActivity(pollCollection, pollTokenId, ac.signal)
      if (cancelled || next.length === 0) return
      setRows((cur) => mergeTape(cur, next, cap))
    }

    const stop = () => {
      if (timer != null) window.clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      timer = window.setInterval(() => {
        void pull()
      }, POLL_MS)
    }

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      void pull()
      start()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      stop()
      ac.abort()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [pollCollection, pollTokenId, cap])

  if (rows.length === 0) {
    return (
      <div className="rounded-[24px] border border-hair bg-s1 px-4 py-10 text-center text-[15px] text-t3">
        {empty}
      </div>
    )
  }
  return (
    <div className="divide-y divide-hair2 overflow-hidden rounded-[24px] border border-hair bg-s1">
      {rows.map((e) => {
        const col = collection || slugs?.[e.collection.toLowerCase()] || e.collection
        const href =
          col && e.tokenId !== '0'
            ? `/studio/${col}/${e.tokenId}`
            : col
              ? `/studio/${col}`
              : undefined
        const name = names?.[e.collection.toLowerCase()]
        const row = (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{LABEL[e.type]}</div>
              <div className="mt-0.5 truncate text-[13px] text-t3">
                {name ? `${name} · ` : ''}
                {e.tokenId === '0' ? 'Collection' : `#${e.tokenId}`}
                <span className="text-white/20"> · </span>
                {timeAgo(e.at)}
              </div>
            </div>
            <div className="shrink-0 text-[14px] font-semibold tabular-nums">
              {formatUsdc(atomicToUsdc(e.priceAtomic))} USDC
            </div>
          </div>
        )
        return href ? (
          <Link key={activityKey(e)} href={href} className="block text-white hover:bg-s2/60 hover:text-white">
            {row}
          </Link>
        ) : (
          <div key={activityKey(e)}>{row}</div>
        )
      })}
    </div>
  )
}
