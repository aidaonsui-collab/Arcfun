'use client'

/**
 * Candlestick + volume chart via TradingView's lightweight-charts (open-source, Apache-2.0 —
 * not the paid Charting Library). Colors/layout matched by inspecting RadarDEX's rendered
 * chart directly (same library, same pixel colors sampled off their canvas):
 *   background #0F2137, grid disabled (same color as bg), up #26C281, down #F0616D,
 *   volume bars same hues at ~33% opacity, overlaid in the bottom of the same pane.
 */
import { useEffect, useRef } from 'react'
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Candle } from '@/lib/candles'

const BG = '#0F2137'
const UP = '#26C281'
const DOWN = '#F0616D'
const UP_VOL = 'rgba(63, 213, 147, 0.33)'
const DOWN_VOL = 'rgba(255, 99, 117, 0.33)'

/**
 * lightweight-charts defaults to 2-decimal price precision, which rounds meme-coin-scale
 * prices (e.g. 9.4e-10) straight to 0 and breaks the whole axis. Derive enough decimal
 * places from the price's magnitude to keep ~3 significant digits visible, same problem
 * every DEX chart (RadarDEX included) has to solve for sub-cent tokens.
 */
function priceFormatFor(price: number): { precision: number; minMove: number } {
  if (!(price > 0)) return { precision: 2, minMove: 0.01 }
  const magnitude = Math.floor(Math.log10(price))
  const precision = Math.min(18, Math.max(2, -magnitude + 2))
  return { precision, minMove: Math.pow(10, -precision) }
}

export function TokenChart({ candles, height = 280 }: { candles: Candle[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: 'rgba(255,255,255,0.5)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: BG },
        horzLines: { color: BG },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, barSpacing: 10 },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.25)', labelBackgroundColor: '#1C3552' },
        horzLine: { color: 'rgba(255,255,255,0.25)', labelBackgroundColor: '#1C3552' },
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
    })
    candleSeriesRef.current = candleSeries

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '', // overlay on its own hidden scale, not the price axis
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    volumeSeriesRef.current = volumeSeries

    return () => {
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!candleSeries || !volumeSeries) return

    const lastClose = candles[candles.length - 1]?.close ?? 0
    candleSeries.applyOptions({ priceFormat: { type: 'price', ...priceFormatFor(lastClose) } })

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
    // autoSize's ResizeObserver hasn't necessarily applied the container's real width by the
    // time setData() returns on first mount — computing bar spacing against a stale/placeholder
    // width squeezes every bar into a sliver. One rAF is enough to land after that resize.
    //
    // fitContent() stretches whatever bars exist to fill the full container width — great for a
    // chart with plenty of bars, but a thinly-traded token with only a handful of real candles
    // (even after candles.ts's gap-backfill) would get blown up into a few giant blocks instead
    // of rendering at a normal, fixed bar width. Only fit when there are enough bars that fitting
    // actually means "zoom out slightly"; otherwise keep the fixed barSpacing and just pin the
    // view to the right (real-time) edge.
    const raf = requestAnimationFrame(() => {
      const chart = chartRef.current
      if (!chart) return
      if (candles.length > 60) {
        chart.timeScale().fitContent()
      } else {
        chart.timeScale().scrollToRealTime()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [candles])

  return <div ref={containerRef} style={{ height, width: '100%' }} />
}
