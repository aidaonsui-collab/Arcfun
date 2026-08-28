/**
 * Instant mint used by the mention bot and the x402 pay-to-launch route.
 */
import { erc20Abi, parseEventLogs, type Address, type Hex } from 'viem'
import { type BlitzTweet } from './arc-blitz'
import { blitzTokenImageUrl } from './arc-blitz-image'
import { buildCreateTokenMemeInstantArc, parseArcUsdc } from './arc-instant-launchpad'
import { invalidateArcHomeCatalog } from './arc-catalog-cache'
import { setArcTokenMeta } from './arc-token-meta'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'
import {
  ARC,
  ARC_INSTANT_CREATE_GAS,
  arcCreationFeeWeiFor,
  arcPublicClient,
  arcServerWalletClient,
} from './contracts-arc'
import { eveBurnAddress } from './eve'

function env(name: string): string {
  return (process.env[name] || '').trim()
}

export function blitzBotPrivateKey(): Hex | null {
  const raw = env('BLITZ_BOT_KEY')
  if (!raw) return null
  const pk = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null
  return pk as Hex
}

export async function mintOnArc(args: {
  name: string
  symbol: string
  tweet: BlitzTweet
  pk: Hex
}): Promise<{ token: Address; tx: Hex; pool?: Address }> {
  const wallet = arcServerWalletClient(args.pk)
  const client = arcPublicClient()
  const account = wallet.account
  const firstBuy = parseArcUsdc(env('BLITZ_FIRST_BUY_USDC') || '0')
  const feeWei = arcCreationFeeWeiFor(account.address)
  const rewards = eveBurnAddress()

  if (firstBuy > 0n) {
    const approveHash = await wallet.writeContract({
      address: ARC.USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ARC.INSTANT_FACTORY, firstBuy],
      chain: wallet.chain,
    })
    await client.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 })
  }

  const call = buildCreateTokenMemeInstantArc(args.name, args.symbol, firstBuy, feeWei, rewards)
  const hash = await wallet.writeContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName as never,
    args: call.args as never,
    value: call.value,
    gas: ARC_INSTANT_CREATE_GAS,
    chain: wallet.chain,
  })
  const rcpt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 })
  const [created] = parseEventLogs({
    abi: INSTANT_QUOTE_FACTORY_ABI,
    eventName: 'InstantQuoteTokenCreated',
    logs: rcpt.logs,
  })
  const token = created?.args?.token as Address | undefined
  const pool = created?.args?.pool as Address | undefined
  if (!token) throw new Error('minted but InstantQuoteTokenCreated missing')

  try {
    await setArcTokenMeta(token, {
      name: args.name,
      symbol: args.symbol,
      twitter: args.tweet.handle,
      website: args.tweet.url,
      imageUrl: blitzTokenImageUrl(args.tweet.imageUrl),
      description: args.tweet.text,
      creator: account.address,
      pool: pool || undefined,
      instantLaunch: true,
    })
  } catch (e) {
    console.error('[blitz-bot] meta', e instanceof Error ? e.message : 'meta failed')
  }
  try {
    await invalidateArcHomeCatalog()
  } catch {
    /* best-effort */
  }
  return { token, tx: hash, pool }
}
