/**
 * While Rabby/MetaMask is showing a signature popup, extra eth_call through the
 * injected provider resets that popup into a blank Sign screen. Quotes and
 * balance polls must use the public RPC until the popup closes.
 */
let paused = false
const listeners = new Set<() => void>()

export function setWalletRpcPaused(next: boolean) {
  if (paused === next) return
  paused = next
  for (const listener of listeners) listener()
}

export function isWalletRpcPaused() {
  return paused
}

export function subscribeWalletRpcPaused(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
