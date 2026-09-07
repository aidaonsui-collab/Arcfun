/**
 * TradingView charting_library datafeed for ArcFun TOKEN/USDC.
 * Same shape as robinpad `lib/tvDatafeed.ts`. Bars are Unix ms.
 */

export interface TVBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const SUPPORTED_RESOLUTIONS = ['1', '5', '15', '60', '240', '1D']

export function createArcDatafeed(token: string, symbol: string) {
  const subscriptions = new Map<string, ReturnType<typeof setInterval>>()
  const CANDLE_CACHE_TTL_MS = 8_000
  const candleCache = new Map<string, { at: number; promise: Promise<TVBar[]> }>()

  /** `fromSec`/`toSec` omitted → server default window (recent, bounded — see the ohlcv route).
   *  Passed explicitly on scroll-back so the server actually queries further into durable
   *  history instead of us filtering one fixed payload client-side (that's what used to cap
   *  every chart at whatever the KV trade tape's last ~400 swaps covered, regardless of how far
   *  back the user scrolled). */
  function fetchCandles(resolution: string, fromSec?: number, toSec?: number): Promise<TVBar[]> {
    const cacheKey = `${resolution}:${fromSec ?? ''}:${toSec ?? ''}`
    const hit = candleCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CANDLE_CACHE_TTL_MS) return hit.promise
    const promise = (async () => {
      const q = new URLSearchParams({ resolution })
      if (fromSec != null) q.set('from', String(Math.floor(fromSec)))
      if (toSec != null) q.set('to', String(Math.ceil(toSec)))
      const res = await fetch(`/api/arc/${encodeURIComponent(token)}/ohlcv?${q.toString()}`)
      if (!res.ok) return []
      const data = await res.json()
      return (data.candles ?? []) as TVBar[]
    })()
    candleCache.set(cacheKey, { at: Date.now(), promise })
    promise.catch(() => candleCache.delete(cacheKey))
    return promise
  }

  return {
    onReady(callback: (config: object) => void) {
      setTimeout(
        () =>
          callback({
            supported_resolutions: SUPPORTED_RESOLUTIONS,
            supports_search: false,
            supports_group_request: false,
            supports_marks: false,
            supports_timescale_marks: false,
            supports_time: false,
          }),
        0,
      )
    },

    searchSymbols() {},

    resolveSymbol(_symbolName: string, onResolve: (info: object) => void, onError: (err: string) => void) {
      setTimeout(() => {
        if (!token) {
          onError('No token')
          return
        }
        onResolve({
          name: `${symbol}/USDC`,
          ticker: `${symbol}/USDC`,
          description: `${symbol} / USDC`,
          type: 'crypto',
          session: '24x7',
          timezone: 'Etc/UTC',
          minmov: 1,
          pricescale: 1_000_000_000,
          has_intraday: true,
          has_empty_bars: true,
          intraday_multipliers: ['1', '5', '15', '60', '240'],
          has_daily: true,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 3,
          data_status: 'streaming',
          exchange: 'eve.fun',
          listed_exchange: 'eve.fun',
          format: 'price',
        })
      }, 0)
    },

    async getBars(
      _symbolInfo: object,
      resolution: string,
      periodParams: { from: number; to: number; firstDataRequest: boolean; countBack?: number },
      onResult: (bars: TVBar[], meta: { noData: boolean }) => void,
      onError: (err: string) => void,
    ) {
      try {
        if (periodParams.firstDataRequest) {
          const candles = await fetchCandles(resolution)
          onResult(candles, { noData: candles.length === 0 })
          return
        }
        // Scrolling back — ask the server for this exact window (seconds, not ms) instead of
        // filtering the first-load payload; the server can now actually reach further back via
        // durable history.
        const fromRaw = periodParams.from
        const toRaw = periodParams.to
        const fromSec = fromRaw > 1e12 ? fromRaw / 1000 : fromRaw
        const toSec = toRaw > 1e12 ? toRaw / 1000 : toRaw
        const bars = await fetchCandles(resolution, fromSec, toSec)
        onResult(bars, { noData: bars.length === 0 })
      } catch (e) {
        onError((e as Error)?.message ?? 'Failed to fetch bars')
      }
    },

    subscribeBars(
      _symbolInfo: object,
      resolution: string,
      onTick: (bar: TVBar) => void,
      listenerGuid: string,
    ) {
      const interval = setInterval(async () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        try {
          const candles = await fetchCandles(resolution)
          if (!candles.length) return
          onTick(candles[candles.length - 1])
        } catch {
          /* ignore */
        }
      }, 8_000)
      subscriptions.set(listenerGuid, interval)
    },

    unsubscribeBars(listenerGuid: string) {
      const interval = subscriptions.get(listenerGuid)
      if (interval !== undefined) {
        clearInterval(interval)
        subscriptions.delete(listenerGuid)
      }
    },
  }
}
