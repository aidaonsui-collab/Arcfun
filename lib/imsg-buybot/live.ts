/**
 * Live Arc reads for the buy-bot: quote + calls from the same arc-swap helpers the web UI uses
 * (no forked swap math), and balances. Read-only — nothing here signs or broadcasts.
 */
import { encodeFunctionData, erc20Abi, type Abi, type Address } from 'viem'
import { ARC, arcPublicClient } from '../contracts-arc'
import {
  arcSwapSpender,
  buildArcBuy,
  encodeApprove,
  findArcPoolFee,
  minOutFromSlippage,
  quoteArcBuy,
} from '../arc-swap'
import { EVE_POOL_FEE, EVE_TOKEN } from '../eve'
import type { BuyPlan } from './bot'
import type { Call } from './kernel'

export async function quoteEveBuy(
  usdcIn: bigint,
  account: Address | null,
  slippageBps = 100,
): Promise<BuyPlan> {
  const poolFee = (await findArcPoolFee(EVE_TOKEN)) ?? EVE_POOL_FEE
  const quotedOut = await quoteArcBuy(EVE_TOKEN, usdcIn, '')
  if (quotedOut == null || quotedOut <= 0n) throw new Error('no $EVE quote')
  const minOut = minOutFromSlippage(quotedOut, slippageBps)
  const spender = arcSwapSpender('buy')
  const buy = buildArcBuy(EVE_TOKEN, usdcIn, minOut, poolFee, '')

  // Exact-amount approve, never the web UI's unlimited one: the session key must not leave standing allowance.
  const allowance = account
    ? await arcPublicClient().readContract({
        address: ARC.USDC,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, spender],
      })
    : 0n
  const calls: Call[] = []
  if (allowance < usdcIn) {
    calls.push({ target: ARC.USDC, value: 0n, data: encodeApprove(ARC.USDC, spender, usdcIn) })
  }
  calls.push({
    target: buy.address,
    value: 0n,
    data: encodeFunctionData({ abi: buy.abi as Abi, functionName: buy.functionName, args: buy.args }),
  })
  return { usdcIn, quotedOut, minOut, poolFee, platformFeeBps: ARC.FEE_BPS || 100, slippageBps, calls }
}

export async function readBalances(account: Address): Promise<{ usdc: bigint; token: bigint }> {
  const c = arcPublicClient()
  const [usdc, token] = await Promise.all([
    c.readContract({ address: ARC.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    c.readContract({ address: EVE_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
  ])
  return { usdc, token }
}
