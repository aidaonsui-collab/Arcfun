import Link from 'next/link'
import { ARC_EXPLORER } from '@/lib/contracts-arc'

export function Footer() {
  return (
    <footer className="border-t border-hair mt-8">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5 text-[13px] text-t3">
        <p className="max-w-xl leading-relaxed">
          Arcfun — Instant token launches on{' '}
          <a
            href={ARC_EXPLORER || 'https://arcscan.app'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-t2 hover:text-white"
          >
            Arc
          </a>
          . Full supply on Uniswap V3 from block one; launch-token LP fees are auto-burned.
        </p>
        <div className="flex items-center gap-5 font-medium text-t2">
          <Link href="/create" className="hover:text-white">
            Launch
          </Link>
          <a
            href="https://x.com/Arcfun_pad"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white"
          >
            X
          </a>
          <a
            href="https://t.me/ArcFun_pad"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white"
          >
            TG
          </a>
          <a
            href={ARC_EXPLORER || 'https://arcscan.app'}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white"
          >
            ArcScan
          </a>
        </div>
      </div>
    </footer>
  )
}
