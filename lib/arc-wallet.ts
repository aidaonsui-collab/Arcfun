/**
 * Connect / switch helpers for Arc (5042).
 *
 * Header Connect used to always hit `connectors[0]` (injected window.ethereum).
 * Coinbase Wallet / the Base app owns that slot on a lot of machines, so
 * disconnect → reconnect stayed on Base with no picker and no add-chain path.
 */
import type { Connector } from 'wagmi'
import { ARC_CHAIN_ID, ARC_EXPLORER, arcBrowserRpcUrls, arcChain } from './contracts-arc'

export const ARC_CHAIN_HEX = `0x${ARC_CHAIN_ID.toString(16)}` as const

export function walletLabel(connector: Connector): string {
  const n = (connector.name || connector.id || 'Wallet').trim()
  if (/coinbase/i.test(n) || n === 'Base Account' || n === 'Base') return 'Coinbase / Base'
  if (/walletconnect/i.test(n) || connector.id === 'walletConnect') return 'WalletConnect'
  if (/injected/i.test(n) && connector.id === 'injected') return 'Browser wallet'
  return n
}

export function uniqueConnectors(connectors: readonly Connector[]): Connector[] {
  const seen = new Set<string>()
  const out: Connector[] = []
  for (const c of connectors) {
    const key = `${c.type}:${c.id}:${c.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

export function isBaseLockedWallet(connector: Connector | undefined): boolean {
  if (!connector) return false
  const n = `${connector.name} ${connector.id} ${connector.type}`
  return /coinbase|base account|basewallet/i.test(n)
}

type ConnectFn = (args: { connector: Connector; chainId?: number }) => void

/** Prefer a non-Coinbase injected wallet when several are announced (EIP-6963). */
export function preferredConnector(connectors: readonly Connector[]): Connector | undefined {
  const list = uniqueConnectors(connectors)
  return list.find((c) => !isBaseLockedWallet(c)) || list[0]
}

export function connectToArc(connect: ConnectFn, connectors: readonly Connector[], connector?: Connector) {
  const c = connector || preferredConnector(connectors)
  if (!c) return
  connect({ connector: c, chainId: ARC_CHAIN_ID })
}

function switchErrorMessage(err: unknown): string {
  const e = err as { code?: number; shortMessage?: string; message?: string }
  const msg = e.shortMessage || e.message || String(err)
  if (e.code === 4902 || /unrecognized chain|chain not added|4902/i.test(msg)) {
    return 'This wallet does not have Arc yet. Add chain 5042 (USDC gas) or connect MetaMask / Rabby / WalletConnect.'
  }
  if (/rejected|denied|cancel/i.test(msg)) return 'Switch was rejected in the wallet.'
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg
}

/** wallet_switchEthereumChain, then wallet_addEthereumChain on 4902. */
export async function addOrSwitchArc(): Promise<void> {
  const eth =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } })
          .ethereum
  if (!eth?.request) throw new Error('No browser wallet found.')
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ARC_CHAIN_HEX }],
    })
    return
  } catch (err) {
    const code = (err as { code?: number })?.code
    if (code !== 4902 && code !== -32603) throw new Error(switchErrorMessage(err))
  }
  // arcBrowserRpcUrls(), not ARC_RPC_URLS directly — that list is baracat-first, and this is
  // exactly the RPC list the wallet itself will keep using for this chain from here on (see
  // arcBrowserRpcUrls's doc comment for the live incident this caused).
  const rpcUrls = arcBrowserRpcUrls()
  await eth.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: ARC_CHAIN_HEX,
        chainName: arcChain.name,
        nativeCurrency: arcChain.nativeCurrency,
        rpcUrls,
        blockExplorerUrls: ARC_EXPLORER ? [ARC_EXPLORER] : undefined,
      },
    ],
  })
}

export function formatSwitchError(err: unknown): string {
  return switchErrorMessage(err)
}
