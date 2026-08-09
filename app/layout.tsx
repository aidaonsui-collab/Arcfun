import './globals.css'
import type { Metadata } from 'next'
import { Providers } from './providers'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { Analytics } from '@vercel/analytics/next'

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://arcfun.lol'
const TITLE = 'Arcfun — Instant token launches on Arc'
const DESCRIPTION =
  'Launch a token on Arc mainnet in one transaction. Full supply straight onto Uniswap V3, LP locked a year.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'Arcfun',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
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
