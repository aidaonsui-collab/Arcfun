/**
 * Open Graph cards for Instant token pages — pfp + name/symbol, Arcfun chrome.
 * Reuses Studio's image fetch so remote logos survive ImageResponse.
 */
import { ImageResponse } from 'next/og'
import { fetchOgImageSrc } from '@/lib/port/seo'
import { OG_SIZE, fallbackOgImage } from '@/lib/port/og-card'

export { OG_SIZE }

export type TokenOgInput = {
  address: string
  name?: string
  symbol?: string
  imageUrl?: string
}

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || '—'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export async function tokenOgImage(t: TokenOgInput) {
  const art = await fetchOgImageSrc(t.imageUrl, { width: 630, height: 630 })
  const symbol = (t.symbol || '').trim() || shortAddr(t.address)
  const name = (t.name || '').trim() || symbol

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: '#0a0f18',
          color: '#fff',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: 630,
            height: 630,
            backgroundColor: '#12151c',
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={630} height={630} style={{ objectFit: 'cover' }} />
          ) : (
            <div
              style={{
                display: 'flex',
                width: 420,
                height: 420,
                borderRadius: 210,
                backgroundColor: '#1a2030',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 96,
                fontWeight: 700,
                color: '#7ec0f7',
                letterSpacing: '-0.04em',
              }}
            >
              {(symbol || '?').charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '56px 48px',
            width: 570,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 18,
              color: '#7ec0f7',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 14,
            }}
          >
            Arcfun
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 52,
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
              marginBottom: 12,
            }}
          >
            {`$${symbol}`}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              color: 'rgba(255,255,255,0.72)',
              marginBottom: 28,
              lineHeight: 1.25,
            }}
          >
            {name}
          </div>
          <div style={{ display: 'flex', fontSize: 20, color: 'rgba(255,255,255,0.45)' }}>
            Instant · Trade in USDC · arcfun.co
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  )
}

export function fallbackTokenOgImage() {
  return fallbackOgImage('Arcfun')
}
