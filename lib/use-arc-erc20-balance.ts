'use client'

/**
 * ERC-20 balance via the connected wallet's Arc RPC when possible.
 * useReadContract with chainId uses wagmi's public transport (baracat hang),
 * which is why MAX sat at 0 for seconds after Connect while the wallet already
 * knew the balance.
 */
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { readContract } from 'viem/actions'
import { useConnectorClient, usePublicClient } from 'wagmi'
import { ARC_CHAIN_ID } from './contracts-arc'

export function useArcErc20Balance(token: Address | undefined, owner: Address | undefined) {
  const { data: wallet } = useConnectorClient({ chainId: ARC_CHAIN_ID })
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })

  return useQuery({
    queryKey: ['arc-erc20-bal', token, owner, wallet ? 'wallet' : 'public'],
    enabled: Boolean(token && owner && (wallet || publicClient)),
    staleTime: 4_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<bigint> => {
      const client = wallet ?? publicClient
      if (!client || !token || !owner) return 0n
      return readContract(client, {
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      })
    },
  })
}
