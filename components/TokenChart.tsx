'use client'

/**
 * Candlestick + volume — pools.trade / Uniswap Pools layout:
 * dotted grid, last-price line, volume pane, date axis, crosshair OHLC.
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
  onHover,
}: {
  candles: Candle[]
  height?: number
  onHover?: (c: HoverCandle | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
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
      cb({
        time: Number(raw.time),
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: 0,
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
        barSpacing: 8,
        minBarSpacing: 3,
        rightOffset: 4,
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

    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    )
    volumeSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? UP_VOL : DOWN_VOL,
      })),
    )

    requestAnimationFrame(() => {
      chart.timeScale().fitContent()
    })
  }, [candles, ready])

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
