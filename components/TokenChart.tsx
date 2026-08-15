'use client'

/**
 * Candlestick + volume — pools.trade / Uniswap Pools layout:
 * dotted grid, last-price line, volume pane, date axis, crosshair OHLC.
 *
 * Bars are packed with synthetic, evenly-spaced x-axis times (baseTime + i*bucketSec),
 * NOT each candle's real bucket time. lightweight-charts' time scale spaces bars by actual
 * elapsed time between their `time` values, same as any TradingView-family chart — passing
 * real bucket times back-to-back still leaves a wide blank/dotted stretch across any quiet
 * period, even though lib/candles.ts already dropped the empty buckets from the array. A
 * low-volume token like this one trades in bursts, so most of the chart ended up empty space.
 * Synthetic spacing is the standard fix for "pack sparse trades, ignore real gaps" charts
 * (what RadarDEX/pools.trade actually do) — crosshair hover still resolves back to each bar's
 * real time/OHLC/volume via `realByIndex`, so tooltips and the parent's volume lookup stay
 * accurate; only the bar *positions* are synthetic.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type MouseEventParams,
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

function priceFormatFor(price: number): { precision: number; minMove: number } {
  if (!(price > 0)) return { precision: 2, minMove: 0.01 }
  const magnitude = Math.floor(Math.log10(price))
  const precision = Math.min(18, Math.max(2, -magnitude + 2))
  return { precision, minMove: Math.pow(10, -precision) }
}

export type HoverCandle = Candle & { up: boolean }

export function TokenChart({
  candles,
  height = 360,
  bucketSec = 900,
  onHover,
}: {
  candles: Candle[]
  height?: number
  /** Real interval width (seconds) — used only to space the synthetic x-axis readably. */
  bucketSec?: number
  onHover?: (c: HoverCandle | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  // Synthetic chart-time -> real candle, rebuilt whenever `candles` changes. Lets the
  // long-lived crosshair handler (registered once, below) resolve a hover back to real data.
  const realByTimeRef = useRef<Map<number, Candle>>(new Map())
  const [ready, setReady] = useState(0)

  const attachCrosshair = useCallback((chart: IChartApi, series: ISeriesApi<'Candlestick'>) => {
    const handler = (param: MouseEventParams) => {
      const cb = onHoverRef.current
      if (!cb) return
      if (!param.time || !param.point) {
        cb(null)
        return
      }
      const raw = param.seriesData.get(series) as
        | { open: number; high: number; low: number; close: number; time: UTCTimestamp }
        | undefined
      if (!raw) {
        cb(null)
        return
      }
      const real = realByTimeRef.current.get(Number(raw.time))
      cb({
        time: real?.time ?? Number(raw.time),
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: real?.volume ?? 0,
        up: raw.close >= raw.open,
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
        // Fixed thin bars like RadarDEX — never stretch one candle across the pane.
        barSpacing: 6,
        minBarSpacing: 3,
        maxBarSpacing: 10,
        rightOffset: 8,
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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: UP,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1,
    })
    candleSeriesRef.current = candleSeries

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

    const unsub = attachCrosshair(chart, candleSeries)
    setReady((n) => n + 1)

    return () => {
      unsub()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, [attachCrosshair])

  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    const chart = chartRef.current
    if (!candleSeries || !volumeSeries || !chart) return

    const lastClose = candles[candles.length - 1]?.close ?? 0
    const lastUp = (candles[candles.length - 1]?.close ?? 0) >= (candles[candles.length - 1]?.open ?? 0)
    candleSeries.applyOptions({
      priceFormat: { type: 'price', ...priceFormatFor(lastClose) },
      priceLineColor: lastUp ? UP : DOWN,
    })

    // Synthetic, evenly-spaced x-axis so a real trading gap (this token bursts, then goes
    // quiet for hours) doesn't stretch into a blank/dotted gap on the pane — see the file-top
    // comment. Anchored to the first real candle's actual time so axis labels still read as
    // plausible clock times, just not necessarily each bar's true timestamp.
    const baseTime = candles[0]?.time ?? 0
    const syntheticTime = (i: number) => (baseTime + i * bucketSec) as UTCTimestamp

    const realByTime = new Map<number, Candle>()
    candles.forEach((c, i) => realByTime.set(syntheticTime(i), c))
    realByTimeRef.current = realByTime

    candleSeries.setData(
      candles.map((c, i) => ({
        time: syntheticTime(i),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    )
    volumeSeries.setData(
      candles.map((c, i) => ({
        time: syntheticTime(i),
        value: c.volume,
        color: c.close >= c.open ? UP_VOL : DOWN_VOL,
      })),
    )

    requestAnimationFrame(() => {
      chart.timeScale().applyOptions({ barSpacing: 6, maxBarSpacing: 10 })
      // Not scrollToRealTime() — our x-axis is synthetic, not wall-clock, so "real time" isn't
      // meaningful here. scrollToPosition(0, …) brings the last bar to rightOffset from the edge.
      chart.timeScale().scrollToPosition(0, false)
    })
  }, [candles, bucketSec, ready])

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
