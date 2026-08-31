'use client'

import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { base, arbitrum, mainnet } from 'wagmi/chains'
import { arcChain, arcBrowserTransport } from '@/lib/contracts-arc'

// Multi-chain: Arc (launchpad) + Base/ARB/ETH (Arc OTC payment spokes).
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

const wagmiConfig = createConfig({
  chains: [arcChain, base, arbitrum, mainnet],
  connectors: [
    injected(),
    ...(wcProjectId
      ? [
          walletConnect({
            projectId: wcProjectId,
            showQrModal: true,
            metadata: {
              name: 'ArcFun',
              description: 'Instant token launches on Arc',
              url: process.env.NEXT_PUBLIC_APP_URL || 'https://arcfun.lol',
              icons: [`${process.env.NEXT_PUBLIC_APP_URL || 'https://arcfun.lol'}/favicon.ico`],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [arcChain.id]: arcBrowserTransport(),
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC || 'https://mainnet.base.org', {
      timeout: 20_000,
    }),
    [arbitrum.id]: http(
      process.env.NEXT_PUBLIC_ARB_RPC ||
        process.env.NEXT_PUBLIC_ARBITRUM_RPC ||
        'https://arb1.arbitrum.io/rpc',
      { timeout: 20_000 },
    ),
    [mainnet.id]: http(process.env.NEXT_PUBLIC_ETH_RPC || 'https://ethereum.publicnode.com', {
      timeout: 20_000,
    }),
  },
  ssr: true,
})

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
