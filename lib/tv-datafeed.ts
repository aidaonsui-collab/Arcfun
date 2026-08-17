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

function resolutionSec(res: string): number {
  if (res === '1D' || res === 'D') return 86_400
  if (res === '1W' || res === 'W') return 604_800
  const n = Number(res)
  return Number.isFinite(n) && n > 0 ? n * 60 : 900
}

/** Sit volume candles next to each other. TV's time axis would otherwise leave holes for quiet hours. */
function packBars(bars: TVBar[], resolution: string): TVBar[] {
  if (bars.length < 2) return bars
  const stepMs = resolutionSec(resolution) * 1000
  const t0 = bars[0].time
  return bars.map((b, i) => ({ ...b, time: t0 + i * stepMs }))
}

export function createArcDatafeed(token: string, symbol: string) {
  const subscriptions = new Map<string, ReturnType<typeof setInterval>>()
  const CANDLE_CACHE_TTL_MS = 8_000
  const candleCache = new Map<string, { at: number; promise: Promise<TVBar[]> }>()

  function fetchCandles(resolution: string): Promise<TVBar[]> {
    const hit = candleCache.get(resolution)
    if (hit && Date.now() - hit.at < CANDLE_CACHE_TTL_MS) return hit.promise
    const promise = (async () => {
      const res = await fetch(
        `/api/arc/${encodeURIComponent(token)}/ohlcv?resolution=${encodeURIComponent(resolution)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) return []
      const data = await res.json()
      const raw = (data.candles ?? []) as TVBar[]
      const withVol = raw.filter((c) => c.volume > 0 || c.open !== c.close)
      return packBars(withVol.length ? withVol : raw, resolution)
    })()
    candleCache.set(resolution, { at: Date.now(), promise })
    promise.catch(() => candleCache.delete(resolution))
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
          has_empty_bars: false,
          intraday_multipliers: ['1', '5', '15', '60', '240'],
          has_daily: true,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 3,
          data_status: 'streaming',
          exchange: 'ArcFun',
          listed_exchange: 'ArcFun',
          format: 'price',
        })
      }, 0)
    },

    async getBars(
      _symbolInfo: object,
      resolution: string,
      periodParams: { from: number; to: number; firstDataRequest: boolean },
      onResult: (bars: TVBar[], meta: { noData: boolean }) => void,
      onError: (err: string) => void,
    ) {
      try {
        const candles = await fetchCandles(resolution)
        if (!candles.length) {
          onResult([], { noData: true })
          return
        }
        // Packed times are synthetic. Always hand the full series on first load so
        // a 5D wall-clock window doesn't clip or re-open holes.
        if (periodParams.firstDataRequest) {
          onResult(candles, { noData: false })
          return
        }
        const fromMs = periodParams.from * 1000
        const toMs = periodParams.to * 1000
        const bars = candles.filter((c) => c.time >= fromMs && c.time <= toMs)
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
