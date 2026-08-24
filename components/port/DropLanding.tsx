'use client'

import Link from 'next/link'
import { collectionStatus, mintCta, publicMintLive, allowlistWindowLive, type Collection } from '@/lib/port/types'
import { formatInt, formatUsdc, timeUntil } from '@/lib/port/format'
import { studioPath } from '@/lib/port/path'
import { telegramHref, twitterHref, websiteHref } from '@/lib/social-href'

function stageState(start: number, end: number, fallbackLive: boolean) {
  const now = Date.now()
  if (start && now < start) return `Starts in ${timeUntil(start)}`
  if (end && now >= end) return 'Ended'
  if (fallbackLive || (start && now >= start && (!end || now < end))) return 'Live'
  return 'Scheduled'
}

export function DropLanding({
  collection,
  isCreator,
  onMint,
  onSettings,
}: {
  collection: Collection
  isCreator: boolean
  onMint: () => void
  onSettings: () => void
}) {
  const status = collectionStatus(collection)
  const pct = collection.maxSupply > 0 ? Math.min(100, (collection.minted / collection.maxSupply) * 100) : 0
  const alLive = allowlistWindowLive(collection)
  const pubLive = publicMintLive(collection)

  return (
    <div className="mt-6 flex flex-col gap-6 sm:mt-8 sm:flex-row sm:items-start sm:gap-8">
      <div className="w-[220px] shrink-0 overflow-hidden rounded-[22px] border border-hair bg-s1 sm:w-[260px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={collection.image} alt="" className="aspect-square w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-t3">Unrevealed drop</p>
        <h2 className="mt-1 text-[28px] font-semibold tracking-display sm:text-[32px]">Mint {collection.name}</h2>
        <p className="mt-2 text-[15px] text-t2">
          Every token shows this placeholder until the creator reveals. Art and traits stay hidden.
        </p>

        <div className="mt-6">
          <div className="flex items-baseline justify-between text-[15px]">
            <span className="text-t3">Minted</span>
            <span className="font-semibold tabular-nums">
              {formatInt(collection.minted)} / {formatInt(collection.maxSupply)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-s2">
            <div className="h-full rounded-full bg-lime" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-[28px] font-semibold tabular-nums tracking-display">
              {formatUsdc(collection.mintPriceUsdc)}
            </span>
            <span className="text-[15px] text-t3">USDC · {collection.maxPerWallet} per wallet</span>
          </div>
          <p className="mt-3 text-[13px] leading-snug text-t3">
            New collections lock mint price after the first mint or public start, and lock the art
            URI at reveal. The creator can still team-mint remaining supply for free.
          </p>
        </div>

        <div className="mt-6 space-y-2">
          {collection.allowlist ? (
            <div className="flex items-center justify-between rounded-2xl border border-hair bg-s1 px-4 py-3">
              <div>
                <div className="text-[14px] font-semibold">Allowlist</div>
                <div className="text-[13px] text-t3">
                  {collection.allowlistStart
                    ? new Date(collection.allowlistStart).toLocaleString()
                    : 'Open with the list'}
                  {collection.allowlistEnd ? ` → ${new Date(collection.allowlistEnd).toLocaleString()}` : ''}
                </div>
              </div>
              <span className={`text-[13px] font-semibold ${alLive ? 'text-lime-t' : 'text-t3'}`}>
                {stageState(collection.allowlistStart, collection.allowlistEnd, alLive)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-2xl border border-hair bg-s1 px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold">Public</div>
              <div className="text-[13px] text-t3">
                {collection.publicStart ? new Date(collection.publicStart).toLocaleString() : '—'}
              </div>
            </div>
            <span className={`text-[13px] font-semibold ${pubLive ? 'text-lime-t' : 'text-t3'}`}>
              {stageState(collection.publicStart, 0, pubLive)}
            </span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={status !== 'live'}
            onClick={onMint}
            className="inline-flex h-14 min-w-[160px] items-center justify-center rounded-xl bg-lime px-8 text-[16px] font-bold text-white disabled:opacity-50"
          >
            {mintCta(collection)}
          </button>
          {isCreator ? (
            <>
              <button
                type="button"
                onClick={onSettings}
                className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
              >
                Drop settings
              </button>
              <Link
                href={studioPath(collection, 'items')}
                className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
              >
                Upload items
              </Link>
              <Link
                href={studioPath(collection, 'airdrop')}
                className="inline-flex h-14 items-center rounded-xl border border-hair px-5 text-[14px] font-semibold text-white hover:border-lime-line"
              >
                Airdrop
              </Link>
            </>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-3 text-[13px]">
          {twitterHref(collection.twitter || '') ? (
            <a
              href={twitterHref(collection.twitter || '')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-t3 hover:text-white"
            >
              X
            </a>
          ) : null}
          {telegramHref(collection.telegram || '') ? (
            <a
              href={telegramHref(collection.telegram || '')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-t3 hover:text-white"
            >
              Telegram
            </a>
          ) : null}
          {websiteHref(collection.website || '') ? (
            <a
              href={websiteHref(collection.website || '')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-t3 hover:text-white"
            >
              Website
            </a>
          ) : null}
        </div>
      </div>
    </div>
  )
}
