'use client'

/**
 * Robinpad token chart: vendored TradingView Advanced Charts (charting_library),
 * not lightweight-charts and not the DexScreener embed.
 */
import { useEffect, useRef, useState } from 'react'
import { createArcDatafeed } from '@/lib/tv-datafeed'

declare global {
  interface Window {
    TradingView: any
  }
}

function loadScript(onLoad: () => void, onError: () => void) {
  if (typeof window === 'undefined') return
  if (window.TradingView) {
    onLoad()
    return
  }
  const candidates = [
    '/charting_library/charting_library/charting_library.standalone.js',
    '/charting_library/charting_library/charting_library.js',
  ]
  let idx = 0
  const tryNext = () => {
    if (idx >= candidates.length) {
      onError()
      return
    }
    const s = document.createElement('script')
    s.src = candidates[idx++]
    s.async = true
    s.onload = () => {
      if (window.TradingView) onLoad()
      else tryNext()
    }
    s.onerror = tryNext
    document.head.appendChild(s)
  }
  tryNext()
}

export default function TradingViewChart({
  token,
  symbol,
  height = 420,
}: {
  token: string
  symbol: string
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<{ remove: () => void } | null>(null)
  const [ready, setReady] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    loadScript(
      () => setReady(true),
      () => setMissing(true),
    )
  }, [])

  useEffect(() => {
    if (!ready || !containerRef.current || !window.TradingView) return
    if (widgetRef.current) {
      try {
        widgetRef.current.remove()
      } catch {
        /* ignore */
      }
      widgetRef.current = null
    }

    const widget = new window.TradingView.widget({
      container: containerRef.current,
      datafeed: createArcDatafeed(token, symbol),
      library_path: '/charting_library/charting_library/',
      symbol: `${symbol}/USDC`,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'Dark',
      style: '1',
      locale: 'en',
      autosize: true,
      height,
      toolbar_bg: '#131313',
      overrides: {
        'paneProperties.background': '#131313',
        'paneProperties.backgroundType': 'solid',
        'paneProperties.vertGridProperties.color': 'rgba(255,255,255,0.05)',
        'paneProperties.horzGridProperties.color': 'rgba(255,255,255,0.05)',
        'scalesProperties.textColor': '#6b7280',
        'scalesProperties.lineColor': 'rgba(255,255,255,0.08)',
        'mainSeriesProperties.candleStyle.upColor': '#40B66B',
        'mainSeriesProperties.candleStyle.downColor': '#F0616D',
        'mainSeriesProperties.candleStyle.borderUpColor': '#40B66B',
        'mainSeriesProperties.candleStyle.borderDownColor': '#F0616D',
        'mainSeriesProperties.candleStyle.wickUpColor': '#40B66B',
        'mainSeriesProperties.candleStyle.wickDownColor': '#F0616D',
        'mainSeriesProperties.areaStyle.color1': 'rgba(64, 182, 107, 0.28)',
        'mainSeriesProperties.areaStyle.color2': 'rgba(64, 182, 107, 0.02)',
        'mainSeriesProperties.areaStyle.linecolor': '#40B66B',
        'mainSeriesProperties.areaStyle.linewidth': 2,
        volumePaneSize: 'medium',
      },
      disabled_features: [
        'use_localstorage_for_settings',
        'header_symbol_search',
        'header_compare',
        'display_market_status',
        'go_to_date',
      ],
      enabled_features: [
        'hide_last_na_study_output',
        'dont_show_boolean_study_arguments',
        'move_logo_to_main_pane',
        'volume_force_overlay',
      ],
    })
    widgetRef.current = widget

    return () => {
      if (widgetRef.current) {
        try {
          widgetRef.current.remove()
        } catch {
          /* ignore */
        }
        widgetRef.current = null
      }
    }
  }, [ready, token, symbol, height])

  if (missing) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-sm text-t3 bg-[#131313]"
      >
        Chart library unavailable.
      </div>
    )
  }

  if (!ready) {
    return (
      <div style={{ height }} className="flex items-center justify-center bg-[#131313]">
        <div className="w-6 h-6 border-2 border-white/15 border-t-lime-t rounded-full animate-spin" />
      </div>
    )
  }

  return <div ref={containerRef} style={{ height }} className="bg-[#131313]" />
}
