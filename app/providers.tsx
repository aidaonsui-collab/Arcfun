'use client'

import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider, createConfig, http, fallback } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { arcChain, ARC_RPC_URLS } from '@/lib/contracts-arc'

// Single site-wide Wagmi config — ArcFun only ever talks to Arc mainnet (5042).
// - injected(): desktop extensions (MetaMask, Rabby, …) via EIP-6963
// - walletConnect(): mobile QR/deep-link when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

const wagmiConfig = createConfig({
  chains: [arcChain],
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
    // Arc public RPCs rate-limit / reject heavy estimateGas; fallback list softens outages.
    [arcChain.id]:
      ARC_RPC_URLS.length > 1
        ? fallback(ARC_RPC_URLS.map((u) => http(u, { timeout: 20_000 })))
        : http(ARC_RPC_URLS[0] || arcChain.rpcUrls.default.http[0], { timeout: 20_000 }),
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
