'use client'

/**
 * Blitz launch desk — watch X accounts, paste a post, prefill Instant create.
 * Pair is always TOKEN/USDC. Does not auto-mint.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell, BellOff, Loader2, Plus, Zap } from 'lucide-react'
import {
  alertsEnabled,
  draftFromTweet,
  loadSeenIds,
  loadWatchList,
  saveSeenIds,
  saveWatchList,
  sanitizeHandle,
  setAlertsEnabled,
  tweetIdNewer,
  type BlitzPrefill,
  type BlitzTweet,
} from '@/lib/arc-blitz'
import { ArcCreateForm } from '@/components/ArcCreateForm'
import { ageLabel } from '@/lib/ui-format'

function mediaSrc(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('/')) return url
  return `/api/arc/blitz/media?u=${encodeURIComponent(url)}`
}

function beep() {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = 880
    g.gain.value = 0.04
    o.connect(g)
    g.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.12)
  } catch {
    /* no audio */
  }
}

export function BlitzDesk() {
  const [watch, setWatch] = useState<string[]>([])
  const [addHandle, setAddHandle] = useState('')
  const [paste, setPaste] = useState('')
  const [tweets, setTweets] = useState<BlitzTweet[]>([])
  const [live, setLive] = useState(false)
  const [loadingFeed, setLoadingFeed] = useState(true)
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BlitzPrefill | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [alertsOn, setAlertsOn] = useState(false)
  const seenRef = useRef<Record<string, string>>({})
  const primed = useRef(false)

  useEffect(() => {
    setWatch(loadWatchList())
    seenRef.current = loadSeenIds()
    setAlertsOn(alertsEnabled())
  }, [])

  const applyTweet = useCallback((tweet: BlitzTweet) => {
    setDraft(draftFromTweet(tweet))
    setPickedId(tweet.id)
    setError(null)
  }, [])

  const lookup = useCallback(
    async (url: string) => {
      const u = url.trim()
      if (!u) return
      setLooking(true)
      setError(null)
      try {
        const res = await fetch(`/api/arc/blitz/tweet?url=${encodeURIComponent(u)}`)
        const data = (await res.json()) as { tweet?: BlitzTweet; error?: string }
        if (!res.ok || !data.tweet) throw new Error(data.error || 'Tweet not found')
        applyTweet(data.tweet)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'lookup failed')
      } finally {
        setLooking(false)
      }
    },
    [applyTweet],
  )

  const loadFeed = useCallback(async () => {
    const handles = watch.length ? watch : loadWatchList()
    if (!handles.length) {
      setTweets([])
      setLoadingFeed(false)
      return
    }
    try {
      const res = await fetch(`/api/arc/blitz/feed?handles=${encodeURIComponent(handles.join(','))}`)
      const data = (await res.json()) as { tweets?: BlitzTweet[]; live?: boolean }
      const next = data.tweets || []
      setLive(Boolean(data.live))
      setTweets(next)

      if (primed.current && alertsEnabled() && next.length) {
        const seen = seenRef.current
        const fresh = next.filter((t) => {
          const prev = seen[t.handle.toLowerCase()]
          return tweetIdNewer(t.id, prev || '')
        })
        if (fresh.length) {
          const t = fresh[0]
          beep()
          try {
            if (Notification.permission === 'granted') {
              new Notification(`@${t.handle} posted`, { body: t.text.slice(0, 120), silent: true })
            }
          } catch {
            /* ignore */
          }
        }
      }
      primed.current = true
      const nextSeen = { ...seenRef.current }
      for (const t of next) {
        const k = t.handle.toLowerCase()
        if (!nextSeen[k] || tweetIdNewer(t.id, nextSeen[k])) nextSeen[k] = t.id
      }
      seenRef.current = nextSeen
      saveSeenIds(nextSeen)
    } catch {
      /* keep prior tape */
    } finally {
      setLoadingFeed(false)
    }
  }, [watch])

  useEffect(() => {
    void loadFeed()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadFeed()
    }, 20_000)
    return () => clearInterval(id)
  }, [loadFeed])

  const addWatched = () => {
    const h = sanitizeHandle(addHandle)
    if (!h) return
    const next = saveWatchList([h, ...watch])
    setWatch(next)
    setAddHandle('')
  }

  const removeWatched = (h: string) => {
    setWatch(saveWatchList(watch.filter((x) => x.toLowerCase() !== h.toLowerCase())))
  }

  const toggleAlerts = async () => {
    if (!alertsOn) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          await Notification.requestPermission()
        }
      } catch {
        /* ignore */
      }
      setAlertsEnabled(true)
      setAlertsOn(true)
    } else {
      setAlertsEnabled(false)
      setAlertsOn(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-7 items-start">
      <div className="min-w-0">
        <p className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-lime-t">Blitz launch</p>
        <h1 className="m-0 mt-2 text-[32px] sm:text-[40px] font-semibold tracking-display leading-[1.12]">
          Tweet to Instant
        </h1>
        <p className="mt-3 mb-0 max-w-xl text-[16px] text-t2 leading-relaxed">
          Watch an account or paste a post. We fill name, ticker, art, and the tweet link. You
          confirm. Same TOKEN/USDC Instant mint as{' '}
          <Link href="/create" className="text-lime-t font-semibold hover:text-white">
            /create
          </Link>
          . Nothing deploys until you sign.
        </p>

        <form
          className="mt-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void lookup(paste)
          }}
        >
          <input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste an x.com/status/… URL"
            className="flex-1 min-w-0 h-12 px-4 rounded-2xl bg-s2 border border-hair text-[15px] outline-none focus:border-lime-line placeholder:text-white/25"
          />
          <button
            type="submit"
            disabled={looking || !paste.trim()}
            className="h-12 px-5 rounded-2xl bg-lime text-white text-sm font-semibold hover:bg-lime-2 disabled:opacity-50"
          >
            {looking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Pull'}
          </button>
        </form>
        {error ? <p className="mt-2 mb-0 text-[13px] text-coral">{error}</p> : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {watch.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => removeWatched(h)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-hair bg-s2 text-[12px] font-semibold text-t2 hover:text-white"
              title="Remove"
            >
              @{h}
              <span className="text-t3">×</span>
            </button>
          ))}
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              addWatched()
            }}
          >
            <input
              value={addHandle}
              onChange={(e) => setAddHandle(e.target.value)}
              placeholder="@handle"
              className="h-8 w-[7.5rem] px-3 rounded-full bg-s2 border border-hair text-[12px] outline-none focus:border-lime-line placeholder:text-white/25"
            />
            <button
              type="submit"
              className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-hair bg-s2 text-t2 hover:text-white"
              aria-label="Watch handle"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </form>
          <button
            type="button"
            onClick={() => void toggleAlerts()}
            className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-hair bg-s2 text-[12px] font-semibold text-t2 hover:text-white"
          >
            {alertsOn ? <Bell className="w-3.5 h-3.5 text-lime-t" /> : <BellOff className="w-3.5 h-3.5" />}
            {alertsOn ? 'Alerts on' : 'Alerts off'}
          </button>
        </div>

        {!live && !loadingFeed ? (
          <p className="mt-3 mb-0 text-[13px] text-t3 leading-snug">
            Live watch needs <code className="text-t2">X_BEARER_TOKEN</code> on the server. Paste
            still works without it.
          </p>
        ) : null}

        <div className="mt-5 border border-hair rounded-[24px] bg-s1 overflow-hidden">
          <div className="px-5 py-3 border-b border-hair2 flex items-center justify-between">
            <span className="text-[13px] font-semibold">Watch tape</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              {live ? 'Live' : 'Paste'}
            </span>
          </div>
          {loadingFeed && tweets.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-t3">Loading…</p>
          ) : tweets.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-t3">
              No posts yet. Paste a tweet URL to fill the Instant form.
            </p>
          ) : (
            <ul className="m-0 p-0 list-none divide-y divide-hair2">
              {tweets.map((t) => {
                const on = pickedId === t.id
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => applyTweet(t)}
                      className="w-full text-left px-5 py-4 flex gap-3 hover:bg-s2 transition-colors"
                      style={{ background: on ? 'rgba(47,132,219,0.08)' : undefined }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={mediaSrc(t.avatarUrl) || t.avatarUrl}
                        alt=""
                        className="w-10 h-10 rounded-full object-cover bg-s3 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="text-[13px] font-semibold truncate">
                            {t.displayName}{' '}
                            <span className="text-t3 font-medium">@{t.handle}</span>
                          </span>
                          <span className="text-[11px] text-t3 tabular-nums shrink-0">
                            {ageLabel(t.createdAt)} ago
                          </span>
                        </span>
                        <span className="mt-1 block text-[14px] text-t2 leading-snug line-clamp-3">
                          {t.text}
                        </span>
                      </span>
                      {t.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={mediaSrc(t.imageUrl)}
                          alt=""
                          className="w-16 h-16 rounded-xl object-cover bg-s3 shrink-0"
                        />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {draft ? (
          <ArcCreateForm initial={draft} compact />
        ) : (
          <div className="border border-hair rounded-[28px] bg-s1 p-6 sm:p-8">
            <div className="w-11 h-11 rounded-xl bg-s2 border border-hair inline-flex items-center justify-center">
              <Zap className="w-5 h-5 text-lime-t" />
            </div>
            <h2 className="m-0 mt-4 text-[20px] font-semibold tracking-tightish">Pick a post</h2>
            <p className="mt-2 mb-0 text-[14px] text-t2 leading-relaxed">
              Instant create opens here with name, ticker, art, and the tweet as the website
              field. Still one confirm. Pair stays TOKEN/USDC.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
