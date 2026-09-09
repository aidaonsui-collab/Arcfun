/**
 * Manually trigger Crucible.cook() — sweeps the sink's accumulated USDC into $EVE via Arc's
 * Uniswap V3 SwapRouter02, burns the output. This is the buyback-and-burn step that populates
 * the "Burn tape" on /crucible. Nothing in this repo calls it automatically — see the
 * conversation this script came out of; the accumulation side (CrucibleLock → sink) is running
 * fine, this half just isn't wired to anything.
 *
 * Requires a wallet already registered as a keeper on the sink (or the sink's owner — owner is
 * itself a registered keeper today). This will revert immediately for any other caller; I can't
 * check in advance whether your key qualifies without you telling me the address.
 *
 * Sink: 0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6 (Crucible.sol — unverified on-chain; interface
 * below is taken from contracts/crucible/out/Crucible.sol/Crucible.json, the local build
 * artifact, since there's no verified ABI to pull from arcexplorer).
 *
 * Setup — same convention as scripts/launch-liquidity-launcher-token.ts:
 *   KEEPER_PRIVATE_KEY=0x... in .env.local (gitignored). Never paste it in chat.
 *
 * Usage — dry run first (reads live pending balance + price, prints the plan, sends nothing):
 *   npm run cook-crucible
 *
 * Then, once the numbers look right:
 *   npm run cook-crucible -- --yes
 *
 * Optional overrides:
 *   --amount 65.09       USDC amount to cook (defaults to the sink's full current balance)
 *   --slippage 2         percent slippage tolerance for minEveOut (default 2)
 */
import { createWalletClient, http, parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcChain, arcLogsRpcUrls, arcPublicClient, ARC } from '@/lib/contracts-arc'
import { fallback } from 'viem'

const SINK = '0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6' as Address
const USDC = ARC.USDC as Address
const EVE = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF' as Address

const SINK_ABI = [
  { type: 'function', name: 'cook', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'minEveOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'cookPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'keepers', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'Burn', inputs: [{ name: 'token', type: 'address' }, { name: 'usdcIn', type: 'uint256' }, { name: 'eveOut', type: 'uint256' }, { name: 'ts', type: 'uint256' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function parseArgs() {
  const args = process.argv.slice(2)
  const flags: Record<string, string> = {}
  let yes = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes' || args[i] === '-y') { yes = true; continue }
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++ }
  }
  return { flags, yes }
}

async function main() {
  const { flags, yes } = parseArgs()
  const publicClient = arcPublicClient()

  const key = (process.env.KEEPER_PRIVATE_KEY || '').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Set KEEPER_PRIVATE_KEY in .env.local (0x + 64 hex chars). Never pass it as a CLI arg or paste it in chat.')
  }
  const account = privateKeyToAccount(key as Hex)

  const [paused, isKeeper, owner, sinkBalanceRaw] = await Promise.all([
    publicClient.readContract({ address: SINK, abi: SINK_ABI, functionName: 'cookPaused' }),
    publicClient.readContract({ address: SINK, abi: SINK_ABI, functionName: 'keepers', args: [account.address] }),
    publicClient.readContract({ address: SINK, abi: SINK_ABI, functionName: 'owner' }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [SINK] }),
  ])

  console.log('Crucible sink:', SINK)
  console.log('cookPaused:', paused)
  console.log('your address:', account.address)
  console.log('is your address a registered keeper?', isKeeper, isKeeper ? '' : account.address.toLowerCase() === owner.toLowerCase() ? '(but you ARE the owner, who is also a keeper)' : '(sink owner is ' + owner + ' — ask them to setKeeper(you, true) first)')
  if (paused) throw new Error('cookPaused is true — someone paused this on purpose. Not overriding that; ask the owner why before unpausing.')
  if (!isKeeper && account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('This address is not a registered keeper and is not the owner — cook() will revert. Get added via setKeeper() first.')
  }

  const sinkBalance = Number(formatUnits(sinkBalanceRaw, 6))
  console.log('sink USDC balance (pending):', sinkBalance.toFixed(6), 'USDC')

  const requestedAmount = flags.amount ? Number(flags.amount) : sinkBalance
  if (requestedAmount <= 0 || requestedAmount > sinkBalance) {
    throw new Error(`--amount must be > 0 and <= current sink balance (${sinkBalance.toFixed(6)})`)
  }
  const amountIn = parseUnits(requestedAmount.toFixed(6), 6)

  // Live EVE price so minEveOut is grounded in the current pool, not a stale guess.
  const priceRes = await fetch(`https://www.arcexplorer.org/api/v1/tokens/${EVE}`).then((r) => r.json())
  const evePriceUsd = Number(priceRes?.priceUsd)
  if (!(evePriceUsd > 0)) throw new Error('Could not fetch a live EVE price to compute slippage protection — aborting rather than guess.')

  const slippagePct = flags.slippage ? Number(flags.slippage) : 2
  const expectedEveOut = requestedAmount / evePriceUsd
  const minEveOut = expectedEveOut * (1 - slippagePct / 100)
  const minEveOutRaw = parseUnits(minEveOut.toFixed(6), 18)

  console.log('\ncooking', requestedAmount.toFixed(6), 'USDC')
  console.log('live EVE price: $', evePriceUsd)
  console.log('expected EVE out: ~', expectedEveOut.toLocaleString())
  console.log(`minEveOut (${slippagePct}% slippage floor):`, minEveOut.toLocaleString())

  if (!yes) {
    console.log('\nDry run only — nothing sent. Re-run with --yes once this looks right.')
    return
  }

  const rpcUrls = arcLogsRpcUrls()
  const walletClient = createWalletClient({
    account,
    chain: arcChain,
    transport: rpcUrls.length > 1 ? fallback(rpcUrls.map((u) => http(u, { retryCount: 0 }))) : http(rpcUrls[0]),
  })

  console.log('\nSimulating before sending anything...')
  const { request } = await publicClient.simulateContract({
    account,
    address: SINK,
    abi: SINK_ABI,
    functionName: 'cook',
    args: [amountIn, minEveOutRaw],
  })

  console.log('Simulation succeeded. Sending...')
  const hash = await walletClient.writeContract(request)
  console.log('tx sent:', hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  console.log('confirmed in block', receipt.blockNumber, 'status', receipt.status)
}

main().catch((e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
