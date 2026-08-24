import { ImageResponse } from 'next/og'
import type { Collection, NftItem } from './types'
import { formatInt, formatUsdc } from './format'
import { fetchOgImageSrc } from './seo'

export const OG_SIZE = { width: 1200, height: 630 }

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginRight: 40 }}>
      <div
        style={{
          display: 'flex',
          fontSize: 15,
          color: 'rgba(255,255,255,0.52)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', fontSize: 28, color: '#fff', fontWeight: 700, marginTop: 6 }}>
        {value}
      </div>
    </div>
  )
}

function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${formatUsdc(v)} USDC`
}

export async function collectionOgImage(c: Collection) {
  const [banner, avatar] = await Promise.all([
    fetchOgImageSrc(c.banner || c.image, { width: 1200, height: 630 }),
    fetchOgImageSrc(c.image, { width: 400, height: 400 }),
  ])
  const items =
    c.maxSupply > 0 ? `${formatInt(c.minted)} / ${formatInt(c.maxSupply)}` : formatInt(c.minted)
  const countLine = `${formatInt(c.maxSupply || c.minted)} items${
    c.originSymbol ? ` · ${c.originSymbol}` : ''
  }`

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
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
            width: 1200,
            height: 360,
            overflow: 'hidden',
            backgroundColor: '#12151c',
          }}
        >
          {banner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={banner} alt="" width={1200} height={360} style={{ objectFit: 'cover' }} />
          ) : (
            <div
              style={{
                display: 'flex',
                width: 1200,
                height: 360,
                backgroundColor: '#1a2740',
              }}
            />
          )}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flexGrow: 1,
            padding: '28px 48px 36px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {avatar ? (
              <div
                style={{
                  display: 'flex',
                  width: 108,
                  height: 108,
                  borderRadius: 22,
                  overflow: 'hidden',
                  marginRight: 22,
                  backgroundColor: '#12151c',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatar} alt="" width={108} height={108} style={{ objectFit: 'cover' }} />
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  display: 'flex',
                  fontSize: 18,
                  color: '#7ec0f7',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                ArcStudio
              </div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 52,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: '-0.03em',
                  marginTop: 4,
                }}
              >
                {c.name}
              </div>
              <div style={{ display: 'flex', fontSize: 22, color: 'rgba(255,255,255,0.58)', marginTop: 6 }}>
                {countLine}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 18 }}>
            <Stat label="Floor price" value={money(c.floorUsdc)} />
            <Stat label="Top offer" value={money(c.topOfferUsdc)} />
            <Stat label="24h volume" value={money(c.volume24hUsdc)} />
            <Stat label="Items" value={items} />
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  )
}

export async function itemOgImage(c: Collection, item: NftItem) {
  const art = await fetchOgImageSrc(item.image || c.image, { width: 630, height: 630 })
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
          }}
        >
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={630} height={630} style={{ objectFit: 'cover' }} />
          ) : (
            <div
              style={{
                display: 'flex',
                width: 630,
                height: 630,
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 42,
                color: 'rgba(255,255,255,0.4)',
              }}
            >
              {c.name}
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
            {c.name}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 44,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: '-0.03em',
              marginBottom: 16,
            }}
          >
            {item.name}
          </div>
          <div style={{ display: 'flex', fontSize: 22, color: 'rgba(255,255,255,0.55)' }}>
            {`#${item.id} · ArcStudio`}
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  )
}

export function fallbackOgImage(label = 'ArcStudio') {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: '#0a0f18',
          color: '#fff',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 64,
          fontWeight: 700,
          fontFamily: 'sans-serif',
        }}
      >
        {label}
      </div>
    ),
    { ...OG_SIZE },
  )
}