/**
 * Browser helper: wait for an Instant/Reflection create via the server (Infura),
 * not the public wagmi RPC. Public Arc endpoints hang or lag receipts, which is
 * why the create form sat on "Waiting for confirmation…" for minutes.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem'

/** Wait until any Arc tx is mined (HandlePay deployVault, etc.). */
export async function waitArcTxConfirmed(hash: Hex): Promise<void> {
  const res = await fetch(`/api/arc/tx/receipt?hash=${hash}&mined=1`)
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || 'Could not confirm the transaction on Arc.')
  }
}

export async function waitArcCreateConfirmed(hash: Hex): Promise<{ token: Address; pool?: Address }> {
  const res = await fetch(`/api/arc/tx/receipt?hash=${hash}`)
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    token?: string
    pool?: string
    error?: string
  } | null
  const token = data?.token
  if (!res.ok || !token || !isAddress(token)) {
    throw new Error(data?.error || 'Could not confirm the create transaction on Arc.')
  }
  const pool = data.pool && isAddress(data.pool) ? getAddress(data.pool) : undefined
  return { token: getAddress(token), pool }
}
