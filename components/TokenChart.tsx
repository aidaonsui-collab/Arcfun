'use client'

/**
 * Token chart — RadarDEX-style by default:
 * green/red candlesticks on a real time axis. Quiet hours keep last price
 * (filled upstream) so the path is a continuous stair, not a packed fake clock.
 * Line/area is an optional toggle.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type UTCTimestamp,
  type MouseEventParams,
  type SeriesMarker,
} from 'lightweight-charts'
import type { Candle } from '@/lib/candles'
import { fmtUsd } from '@/lib/ui-format'

const BG = '#131313'
const UP = '#40B66B'
const DOWN = '#F0616D'
const UP_VOL = 'rgba(64, 182, 107, 0.38)'
const DOWN_VOL = 'rgba(240, 97, 109, 0.38)'
const GRID = 'rgba(255,255,255,0.055)'
const TEXT = 'rgba(255,255,255,0.45)'

export type ChartStyle = 'line' | 'candles'

export type ChartMarker = {
  time: number
  isBuy: boolean
}

function priceFormatFor(price: number): { precision: number; minMove: number } {
  if (!(price > 0)) return { precision: 2, minMove: 0.01 }
  const magnitude = Math.floor(Math.log10(price))
  const precision = Math.min(18, Math.max(2, -magnitude + 2))
  return { precision, minMove: Math.pow(10, -precision) }
}

export type HoverCandle = Candle & { up: boolean }

export function TokenChart({
  candles,
  markers = [],
  style = 'candles',
  height = 360,
  bucketSec = 900,
  onHover,
}: {
  candles: Candle[]
  markers?: ChartMarker[]
  style?: ChartStyle
  height?: number
  /** Used only in candle mode to space the synthetic x-axis. */
  bucketSec?: number
  onHover?: (c: HoverCandle | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const markerApiRef = useRef<ISeriesMarkersPluginApi<any> | null>(null)
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const realByTimeRef = useRef<Map<number, Candle>>(new Map())
  const [ready, setReady] = useState(0)

  const attachCrosshair = useCallback((chart: IChartApi, series: ISeriesApi<'Area'> | ISeriesApi<'Candlestick'>) => {
    const handler = (param: MouseEventParams) => {
      const cb = onHoverRef.current
      if (!cb) return
      if (!param.time || !param.point) {
        cb(null)
        return
      }
      const raw = param.seriesData.get(series) as
        | { open: number; high: number; low: number; close: number; time: UTCTimestamp }
        | { value: number; time: UTCTimestamp }
        | undefined
      if (!raw) {
        cb(null)
        return
      }
      const t = Number(raw.time)
      const real = realByTimeRef.current.get(t)
      if ('close' in raw) {
        cb({
          time: real?.time ?? t,
          open: raw.open,
          high: raw.high,
          low: raw.low,
          close: raw.close,
          volume: real?.volume ?? 0,
          up: raw.close >= raw.open,
        })
        return
      }
      const close = raw.value
      cb({
        time: real?.time ?? t,
        open: real?.open ?? close,
        high: real?.high ?? close,
        low: real?.low ?? close,
        close,
        volume: real?.volume ?? 0,
        up: close >= (real?.open ?? close),
      })
    }
    chart.subscribeCrosshairMove(handler)
    return () => chart.unsubscribeCrosshairMove(handler)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: TEXT,
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: GRID, style: LineStyle.Dotted },
        horzLines: { color: GRID, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        minBarSpacing: 0.5,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255,255,255,0.22)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2a2a',
        },
        horzLine: {
          color: 'rgba(255,255,255,0.22)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2a2a',
        },
      },
      autoSize: true,
    })
    chartRef.current = chart

    const last = candles[candles.length - 1]
    const first = candles[0]
    const up = (last?.close ?? 0) >= (first?.open ?? last?.close ?? 0)
    const tone = up ? UP : DOWN

    let priceSeries: ISeriesApi<'Area'> | ISeriesApi<'Candlestick'>
    if (style === 'line') {
      priceSeries = chart.addSeries(AreaSeries, {
        lineColor: tone,
        topColor: up ? 'rgba(64, 182, 107, 0.28)' : 'rgba(240, 97, 109, 0.28)',
        bottomColor: up ? 'rgba(64, 182, 107, 0.02)' : 'rgba(240, 97, 109, 0.02)',
        lineWidth: 2,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: tone,
        priceLineStyle: LineStyle.Solid,
        priceLineWidth: 1,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      })
    } else {
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP,
        downColor: DOWN,
        borderUpColor: UP,
        borderDownColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
        lastValueVisible: true,
        priceLineVisible: false,
      })
    }
    priceSeriesRef.current = priceSeries
    markerApiRef.current = createSeriesMarkers(priceSeries, [])

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })
    volumeSeriesRef.current = volumeSeries

    const unsub = attachCrosshair(chart, priceSeries)
    setReady((n) => n + 1)

    return () => {
      unsub()
      markerApiRef.current = null
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volumeSeriesRef.current = null
    }
    // Rebuild when the style changes so we don't leak mixed series types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachCrosshair, style])

  useEffect(() => {
    const priceSeries = priceSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    const chart = chartRef.current
    if (!priceSeries || !volumeSeries || !chart) return

    const lastClose = candles[candles.length - 1]?.close ?? 0
    const firstOpen = candles[0]?.open ?? lastClose
    const up = lastClose >= firstOpen
    const tone = up ? UP : DOWN
    priceSeries.applyOptions({
      priceFormat: { type: 'price', ...priceFormatFor(lastClose) },
      ...(style === 'line'
        ? {
            lineColor: tone,
            topColor: up ? 'rgba(64, 182, 107, 0.28)' : 'rgba(240, 97, 109, 0.28)',
            bottomColor: up ? 'rgba(64, 182, 107, 0.02)' : 'rgba(240, 97, 109, 0.02)',
            priceLineColor: tone,
          }
        : { priceLineColor: tone }),
    })

    const realByTime = new Map<number, Candle>()
    candles.forEach((c) => realByTime.set(c.time, c))
    realByTimeRef.current = realByTime

    if (style === 'line') {
      ;(priceSeries as ISeriesApi<'Area'>).setData(
        candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })),
      )
    } else {
      ;(priceSeries as ISeriesApi<'Candlestick'>).setData(
        candles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      )
    }

    volumeSeries.setData(
      candles
        .filter((c) => c.volume > 0)
        .map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? UP_VOL : DOWN_VOL,
        })),
    )

    const used = new Set<number>()
    const lwMarkers: SeriesMarker<UTCTimestamp>[] = []
    for (const m of markers) {
      let t = m.time
      if (!realByTime.has(t)) {
        let nearest = 0
        let best = Infinity
        realByTime.forEach((_, key) => {
          const dt = Math.abs(key - t)
          if (dt < best) {
            best = dt
            nearest = key
          }
        })
        t = nearest
      }
      if (!t || used.has(t)) continue
      used.add(t)
      lwMarkers.push({
        time: t as UTCTimestamp,
        position: m.isBuy ? 'belowBar' : 'aboveBar',
        color: m.isBuy ? UP : DOWN,
        shape: 'circle',
        text: m.isBuy ? 'B' : 'S',
      })
    }
    markerApiRef.current?.setMarkers(lwMarkers)

    requestAnimationFrame(() => {
      chart.timeScale().fitContent()
    })
  }, [candles, markers, bucketSec, ready, style])

  return (
    <div className="relative w-full" style={{ height, background: BG }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

export function ohlcLabel(c: Pick<Candle, 'open' | 'high' | 'low' | 'close' | 'volume'>, fmt = fmtUsd) {
  return {
    o: fmt(c.open),
    h: fmt(c.high),
    l: fmt(c.low),
    c: fmt(c.close),
    v: fmt(c.volume),
  }
}
