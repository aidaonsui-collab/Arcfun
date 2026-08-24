import type { Metadata } from 'next'
import { StudioRail } from '@/components/port/StudioRail'

const TITLE = 'ArcStudio — Launch and trade NFTs on Arc'
const DESCRIPTION = 'Launch and trade NFTs on Arc. Mint in USDC.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/studio',
    siteName: 'ArcStudio',
    locale: 'en_US',
    type: 'website',
    images: [
      {
        url: '/og-studio.png',
        width: 1600,
        height: 900,
        alt: 'ArcStudio — Launch and trade NFTs on Arc. Mint in USDC.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og-studio.png'],
  },
}

export default function PortLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StudioRail />
      <div className="lg:pl-[88px]">{children}</div>
    </>
  )
}
