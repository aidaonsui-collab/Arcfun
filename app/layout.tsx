import './globals.css'
import type { Metadata } from 'next'
import { Inter, Space_Grotesk, Space_Mono } from 'next/font/google'
import { Providers } from './providers'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { Analytics } from '@vercel/analytics/next'

const inter = Inter({ subsets: ['latin'] })
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' })
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-space-mono' })

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://arcfun.lol'
const TITLE = 'ArcFun — Instant token launches on Arc'
const DESCRIPTION = 'Launch a token on Arc mainnet in one transaction. Full supply straight onto Uniswap V3, LP locked a year.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'ArcFun',
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
    <html lang="en" className={`${spaceGrotesk.variable} ${spaceMono.variable}`}>
      <body className={`${inter.className} bg-black text-white antialiased`}>
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
