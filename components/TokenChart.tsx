'use client'

/**
 * Candlestick + volume chart via TradingView lightweight-charts.
 * Optional opt-in trader PFP markers (wallets with ArcFun profile + avatar).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
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
import { fmtUsd, shortAddr } from '@/lib/ui-format'

const BG = '#0F2137'
const UP = '#26C281'
const DOWN = '#F0616D'
const UP_VOL = 'rgba(63, 213, 147, 0.33)'
const DOWN_VOL = 'rgba(255, 99, 117, 0.33)'

const PFP_SIZE = 28
const MAX_PFPS = 48
const MIN_USD = 0.5

export type ChartTradeMarker = {
  time: number
  price: number
  isBuy: boolean
  avatarUrl: string
  trader: string
  displayName?: string
  twitter?: string
  valueUsd?: number
}

function priceFormatFor(price: number): { precision: number; minMove: number } {
  if (!(price > 0)) return { precision: 2, minMove: 0.01 }
  const magnitude = Math.floor(Math.log10(price))
  const precision = Math.min(18, Math.max(2, -magnitude + 2))
  return { precision, minMove: Math.pow(10, -precision) }
}

type Pos = { left: number; top: number; marker: ChartTradeMarker }

export function TokenChart({
  candles,
  height = 280,
  markers = [],
}: {
  candles: Candle[]
  height?: number
  /** Opt-in PFPs only — callers filter to wallets with avatarUrl */
  markers?: ChartTradeMarker[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [positions, setPositions] = useState<Pos[]>([])
  const [hover, setHover] = useState<ChartTradeMarker | null>(null)

  const cappedMarkers = useMemo(() => {
    const sorted = [...markers]
      .filter((m) => m.avatarUrl && m.time > 0 && m.price > 0)
      .filter((m) => (m.valueUsd == null ? true : m.valueUsd >= MIN_USD))
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_PFPS)
    return sorted
  }, [markers])

  const layoutMarkers = useCallback(() => {
    const chart = chartRef.current
    const series = candleSeriesRef.current
    const el = containerRef.current
    if (!chart || !series || !el) {
      setPositions([])
      return
    }
    const ts = chart.timeScale()
    const next: Pos[] = []
    for (const m of cappedMarkers) {
      const x = ts.timeToCoordinate(m.time as UTCTimestamp)
      const y = series.priceToCoordinate(m.price)
      if (x == null || y == null) continue
      if (Number.isNaN(x) || Number.isNaN(y)) continue
      next.push({
        left: x - PFP_SIZE / 2,
        top: y - PFP_SIZE / 2,
        marker: m,
      })
    }
    setPositions(next)
  }, [cappedMarkers])

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
      priceScaleId: '',
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    volumeSeriesRef.current = volumeSeries

    const onRange = () => layoutMarkers()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, [layoutMarkers])

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
    const raf = requestAnimationFrame(() => {
      const chart = chartRef.current
      if (!chart) return
      if (candles.length > 60) {
        chart.timeScale().fitContent()
      } else {
        chart.timeScale().scrollToRealTime()
      }
      layoutMarkers()
    })
    return () => cancelAnimationFrame(raf)
  }, [candles, layoutMarkers])

  useEffect(() => {
    layoutMarkers()
  }, [cappedMarkers, layoutMarkers])

  return (
    <div className="relative" style={{ height, width: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />

      {/* PFP overlay — opt-in profiles only */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {positions.map((p, i) => (
          <button
            key={`${p.marker.trader}-${p.marker.time}-${i}`}
            type="button"
            className="pointer-events-auto absolute rounded-full border-2 overflow-hidden shadow-lg transition-transform hover:scale-110 focus:scale-110 focus:outline-none"
            style={{
              left: p.left,
              top: p.top,
              width: PFP_SIZE,
              height: PFP_SIZE,
              borderColor: p.marker.isBuy ? UP : DOWN,
              zIndex: 5,
              padding: 0,
              background: '#1a1f2a',
            }}
            title={
              p.marker.twitter
                ? `@${p.marker.twitter}`
                : p.marker.displayName || shortAddr(p.marker.trader)
            }
            onClick={(e) => {
              e.stopPropagation()
              setHover(p.marker)
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.marker.avatarUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          </button>
        ))}
      </div>

      {hover ? (
        <div
          className="absolute z-20 w-[240px] rounded-2xl border border-hair bg-s1/95 backdrop-blur-md shadow-2xl p-3.5"
          style={{ right: 12, top: 12 }}
        >
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={hover.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-full object-cover border-2 shrink-0"
              style={{ borderColor: hover.isBuy ? UP : DOWN }}
            />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-semibold truncate">
                {hover.twitter ? `@${hover.twitter}` : hover.displayName || shortAddr(hover.trader)}
              </p>
              <p className="m-0 text-[11px] text-t3 tabular-nums truncate">{shortAddr(hover.trader)}</p>
            </div>
            <button
              type="button"
              className="text-t3 hover:text-white text-xs"
              onClick={() => setHover(null)}
            >
              ✕
            </button>
          </div>
          <div
            className="mt-3 rounded-xl px-3 py-2.5 border"
            style={{
              borderColor: hover.isBuy ? 'rgba(38,194,129,0.35)' : 'rgba(240,97,109,0.35)',
              background: hover.isBuy ? 'rgba(38,194,129,0.08)' : 'rgba(240,97,109,0.08)',
            }}
          >
            <div className="flex items-center justify-between">
              <span
                className="text-xs font-bold tracking-wide"
                style={{ color: hover.isBuy ? UP : DOWN }}
              >
                {hover.isBuy ? 'BUY' : 'SELL'}
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {hover.valueUsd != null ? fmtUsd(hover.valueUsd) : '—'}
              </span>
            </div>
          </div>
          <Link
            href={`/creator/${hover.trader}`}
            className="mt-3 flex items-center justify-between text-[12px] font-semibold text-lime-t hover:text-white"
            onClick={() => setHover(null)}
          >
            View full profile →
          </Link>
        </div>
      ) : null}
    </div>
  )
}
