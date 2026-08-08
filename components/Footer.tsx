import Link from 'next/link'
import { ARC_EXPLORER } from '@/lib/contracts-arc'

export function Footer() {
  return (
    <footer className="border-t border-white/10 mt-16">
      <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-500">
        <p>
          ArcFun — Instant token launches on{' '}
          <a
            href={ARC_EXPLORER || 'https://arcscan.app'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-gray-200"
          >
            Arc
          </a>
          . Full supply on Uniswap V3 from block one, LP locked a year.
        </p>
        <div className="flex items-center gap-4">
          <Link href="/create" className="hover:text-gray-300">
            Launch
          </Link>
          <a
            href={ARC_EXPLORER || 'https://arcscan.app'}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gray-300"
          >
            ArcScan
          </a>
        </div>
      </div>
    </footer>
  )
}
