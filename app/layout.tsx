import './globals.css'
import type { Metadata } from 'next'
import { Providers } from './providers'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { Analytics } from '@vercel/analytics/next'

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://www.eve.fun'
).replace('arcfun.vercel.app', 'www.eve.fun')
const TITLE = 'eve.fun — Instant token launches on Arc'
const DESCRIPTION =
  'Launch a token on Arc mainnet in one transaction. Full supply straight onto Uniswap V3, LP locked.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: '/favicon-32.png?v=4', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-192.png?v=4', sizes: '192x192', type: 'image/png' },
      { url: '/favicon-512.png?v=4', sizes: '512x512', type: 'image/png' },
      { url: '/favicon.ico?v=4', sizes: '48x48' },
    ],
    shortcut: '/favicon-32.png?v=4',
    apple: '/apple-touch-icon.png?v=4',
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'eve.fun',
    locale: 'en_US',
    type: 'website',
    images: [
      {
        url: 'https://www.eve.fun/og-eve.png?v=4',
        width: 1200,
        height: 630,
        alt: 'eve.fun — Instant token launches on Arc',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['https://www.eve.fun/og-eve.png?v=4'],
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
