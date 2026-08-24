import type { Metadata } from 'next'
import { StudioRail } from '@/components/port/StudioRail'

const TITLE = 'ArcStudio — Launch and trade NFTs on Arc'
const DESCRIPTION = 'Launch and trade NFTs on Arc. Mint in USDC.'
const SITE = 'https://www.arcfun.co'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE}/studio`,
    siteName: 'ArcStudio',
    locale: 'en_US',
    type: 'website',
    images: [
      {
        url: `${SITE}/og-studio.png?v=2`,
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
    images: [`${SITE}/og-studio.png?v=2`],
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
