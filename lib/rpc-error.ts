/**
 * lib/rpc-error.ts
 *
 * Compact one-line error summaries for console.error. Passing a raw viem RpcRequestError /
 * ContractFunctionExecutionError straight to console.error prints its full multi-line dump (stack,
 * nested `cause` chain, `metaMessages`, request body — 25-30 lines per call). At the volume the 4663 RPC's
 * rate-limiting generates (tens of thousands of failures/week, fanned out across every EVM token/trade
 * fetcher), that alone drove the bulk of the project's Vercel Observability Events bill. This keeps the
 * same error count and the same diagnostic signal (what failed, why) at a fraction of the log volume.
 */

/** viem errors carry a terse `shortMessage` (e.g. "RPC Request failed.") separate from `.message`, which
 *  is often the full formatted multi-line block — so prefer shortMessage+details over `.message`. */
export function summarizeRpcError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string } | null | undefined
  if (err?.shortMessage) {
    return err.details ? `${err.shortMessage} (${err.details})` : err.shortMessage
  }
  const msg = err?.message ?? String(e)
  const firstLine = msg.split('\n')[0]
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}
