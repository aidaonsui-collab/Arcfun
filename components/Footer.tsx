import Link from 'next/link'
import { ARC_EXPLORER } from '@/lib/contracts-arc'

export function Footer() {
  return (
    <footer className="border-t border-hair mt-8">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-10 flex items-center justify-end gap-5 text-[13px] text-t3">
        <div className="flex items-center gap-5 font-medium text-t2">
          <Link href="/docs" className="hover:text-white">
            Docs
          </Link>
          <Link href="/docs#agents" className="hover:text-white">
            Agents
          </Link>
          <Link href="/port" className="hover:text-white">
            ArcStudio
          </Link>
          <Link href="/otc" className="hover:text-white">
            Arc OTC
          </Link>
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
            aria-label="Telegram"
            title="Telegram"
            className="inline-flex items-center hover:text-white"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-[15px] w-[15px]"
              fill="currentColor"
              aria-hidden
            >
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
            </svg>
          </a>
          <a
            href={ARC_EXPLORER || 'https://arc-scan.org'}
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
