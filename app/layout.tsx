import './globals.css'
import type { Metadata } from 'next'
import { Providers } from './providers'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { Analytics } from '@vercel/analytics/next'

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arcfun.co'
const TITLE = 'Arcfun — Instant token launches on Arc'
const DESCRIPTION =
  'Launch a token on Arc mainnet in one transaction. Full supply straight onto Uniswap V3, LP locked.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/favicon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/favicon-32.png',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'Arcfun',
    locale: 'en_US',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Arcfun — Launch on Arc. Trade in USDC.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="text-white antialiased">
        <Providers>
          <SiteHeader />
          {children}
          <Footer />
        </Providers>
        <Analytics />
      </body>
    </html>
  )
}
