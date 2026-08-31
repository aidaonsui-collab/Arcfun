import Link from 'next/link'
import { TokenPageClient } from '@/components/TokenPageClient'
import { getArcCatalogToken } from '@/lib/arc-catalog-cache'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { isHiddenToken } from '@/lib/tokens'

function TokenNotFound() {
  return (
    <main className="min-h-screen text-white flex flex-col items-center justify-center gap-4 px-4 pt-16">
      <p className="text-t2">Token not found on Arc.</p>
      <Link href="/create" className="text-lime-t hover:text-white text-sm font-semibold">
        Launch on Arc
      </Link>
    </main>
  )
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params
  if (!isPlausibleEvmAddress(address) || isHiddenToken(address)) {
    return <TokenNotFound />
  }

  let initialPool = null
  try {
    initialPool = await getArcCatalogToken(address)
  } catch {
    /* client fetch fills in */
  }

  return <TokenPageClient key={address} address={address} initialPool={initialPool} />
}
