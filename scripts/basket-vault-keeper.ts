/**
 * BasketVault keeper — pulls accrued RWA-basket fees out of RwaFeeHook into one launch's
 * BasketVault, converts them into the creator-configured basket via the vault's live v4 pools,
 * computes real holder pro-rata weights, and submits disperse() batches.
 *
 * Same trust model as the already-running $EVE holder-rewards keeper
 * (lib/arc-eve-holder-rewards.ts): payout weights are computed off-chain from real balances and
 * submitted as exact amounts — BasketVault.disperse()'s only on-chain guarantee is that a
 * submitted batch can never exceed what actually converted for holders (see BasketVault.sol's
 * top comment for why holder enumeration isn't done on-chain). NOT wired into any cron, same as
 * scripts/cook-crucible.ts — a manual/scheduled-externally trigger, one invocation per
 * basket-enabled launch (one vault per pool, deliberately).
 *
 * Verified end-to-end before being written up as done: deployed a real PoolManager +
 * RwaFeeHook + RwaInstantV4Factory + a basket-enabled launch + two seeded RWA pools to a local
 * Anvil node (contracts/arc-instant-v4/script/LocalAnvilDemo.s.sol) and ran this script against
 * it. That caught two real, previously-"not proven" bugs in the surrounding contracts/scripts
 * that forge's unit tests never exercised (deploying the hook directly in-test never triggers
 * either):
 *   1. RwaFeeHook's constructor set `owner = msg.sender`, but a salted `new X{salt}()` inside a
 *      forge-script broadcast from an EOA is relayed through Foundry's canonical CREATE2 factory
 *      (forge-std's StdConstants.CREATE2_FACTORY) — msg.sender inside that constructor is the
 *      factory contract, not the deploying EOA, permanently locking setFactory/transferOwnership.
 *      Fixed: the constructor now takes an explicit owner_ param.
 *   2. RwaInstantV4Factory._createToken's single-sided launch tick used `tickUpper - TICK_SPACING`
 *      for the "token is currency1" case — one tick spacing *inside* the range, not pinned at the
 *      edge, so the position wasn't actually single-sided and settlement wanted 1 wei of a quote
 *      currency the factory never held. Every existing test happened to deploy LaunchToken18 at
 *      an address below the mock quote's, so this branch was silently never exercised. Fixed:
 *      uses `tickUpper` exactly, matching the symmetric `tickLower` case.
 * Both fixes are in this same PR, with 21/21 pre-existing tests still green.
 *
 * Holder balances here are computed directly from this one token's own Transfer logs, not via
 * lib/evm-holders.ts's getRawHolderBalances — that helper's ledger is keyed off
 * ARC.INSTANT_FACTORY (the V3 pad) and a KV-backed cache built for indexing every pad token at
 * production scale; a V4/BasketVault launch isn't in that registry yet. A from-scratch scan is
 * the right size for "one token, on demand" — wire this into evm-holders.ts's ledger instead if
 * basket-enabled launches ever need the same always-warm indexing the V3 pad gets.
 *
 * Setup — same convention as scripts/cook-crucible.ts:
 *   KEEPER_PRIVATE_KEY=0x...   in .env.local (gitignored). Never paste it in chat.
 *   RPC_URL=http://127.0.0.1:8545   (or a real Arc RPC once a basket-enabled launch exists there)
 *
 * Usage — dry run first (reads live on-chain state, prints the full plan, sends nothing):
 *   npx tsx scripts/basket-vault-keeper.ts --vault 0x... --token 0x... \
 *     --currency 0xQuote[,0xOtherCurrency] --from-block 0
 *
 * Then, once the plan looks right:
 *   npx tsx scripts/basket-vault-keeper.ts --vault 0x... --token 0x... \
 *     --currency 0xQuote --from-block 0 --yes
 *
 * Required:
 *   --vault        BasketVault address
 *   --token        the launched token (for the holder-balance Transfer-log scan)
 *   --currency     comma-separated currencies to pull()/convert() (whatever RwaFeeHook has
 *                  actually accrued to this vault — typically the launch's quote asset; only
 *                  pass one this vault's basket can actually route, see the per-currency
 *                  "convertible?" check this script prints)
 *   --from-block   block the token was launched at (0 is fine for a fresh local chain; on a real
 *                  chain, pass the launch tx's block so the log scan isn't unbounded)
 *
 * Optional:
 *   --slippage N   percent slippage tolerance under the live on-chain price (default 2)
 *   --exclude 0x,0x  extra addresses to exclude from the holder payout, beyond the zero address
 *                    and the vault/hook/pool-manager addresses this script already excludes
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getAddress,
  parseAbiItem,
  keccak256,
  concatHex,
  toHex,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── ABIs — hand-written from the vendored contracts, not fetched from an explorer (none of this
//    is deployed anywhere with a verified ABI yet). Keep in sync with
//    contracts/arc-instant-v4/src/{BasketVault,RwaFeeHook}.sol. ──────────────────────────────
const VAULT_ABI = [
  { type: 'function', name: 'hook', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'creator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'mode', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'rotateIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'basketLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'basket',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'asset', type: 'address' },
      { name: 'weightBps', type: 'uint16' },
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
    ],
  },
  { type: 'function', name: 'pendingConvert', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pendingDistribution', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pull', stateMutability: 'nonpayable', inputs: [{ name: 'currency', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'convert',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fromCurrency', type: 'address' },
      { name: 'minOuts', type: 'uint256[]' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'disperse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'holders', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const

const HOOK_ABI = [
  { type: 'function', name: 'owed', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const POOL_MANAGER_ABI = [
  { type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

type PoolKeyTuple = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
type BasketEntry = { asset: Address; weightBps: number; poolKey: PoolKeyTuple }

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

/** v4-core's StateLibrary.getSlot0 formula, replicated via a plain extsload call — no on-chain
 *  quoter is deployed anywhere this points at yet, and this is exact (reads the real packed
 *  Pool.State.slot0 word), not an approximation. See v4-core/src/libraries/StateLibrary.sol. */
async function readSlot0SqrtPriceX96(client: PublicClient, poolManager: Address, poolId: Hex): Promise<bigint> {
  const POOLS_SLOT = 6n
  const stateSlot = keccakPacked(poolId, POOLS_SLOT)
  const data = (await client.readContract({
    address: poolManager,
    abi: POOL_MANAGER_ABI,
    functionName: 'extsload',
    args: [stateSlot],
  })) as Hex
  const word = BigInt(data)
  const MASK_160 = (1n << 160n) - 1n
  return word & MASK_160
}

function keccakPacked(poolId: Hex, slot: bigint): Hex {
  // keccak256(abi.encodePacked(poolId /* bytes32 */, slot /* uint256, as bytes32 in POOLS_SLOT */))
  // Packed encoding of (bytes32, uint256) is just the 64 raw bytes concatenated.
  return keccak256(concatHex([poolId, toHex(slot, { size: 32 })]))
}

function computePoolId(key: PoolKeyTuple): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [key],
    ),
  )
}

/** First-order price estimate from the live sqrtPriceX96 — same role cook-crucible.ts's live
 *  EVE price fill plays for its minEveOut floor: a slippage-protection floor, not a promise the
 *  real swap (which crosses real ticks and pays the pool's own fee) lands exactly here. The
 *  on-chain SlippageExceeded revert is the actual backstop either way. */
function estimateAmountOut(amountIn: bigint, sqrtPriceX96: bigint, amountInIsCurrency0: boolean): bigint {
  const Q96 = 2 ** 96
  const price = (Number(sqrtPriceX96) / Q96) ** 2 // currency1 per currency0, raw-unit ratio
  const amountInNum = Number(amountIn)
  const amountOutNum = amountInIsCurrency0 ? amountInNum * price : amountInNum / price
  if (!Number.isFinite(amountOutNum) || amountOutNum < 0) throw new Error('price estimate came back non-finite — refusing to compute a minOut from it')
  return BigInt(Math.floor(amountOutNum))
}

async function scanHolderBalances(
  client: PublicClient,
  token: Address,
  fromBlock: bigint,
  exclude: Set<string>,
): Promise<Map<string, bigint>> {
  const latest = await client.getBlockNumber()
  const logs = await client.getLogs({ address: token, event: TRANSFER_EVENT, fromBlock, toBlock: latest })
  const balances = new Map<string, bigint>()
  const ZERO = '0x0000000000000000000000000000000000000000'
  for (const log of logs) {
    const { from, to, value } = log.args as { from: Address; to: Address; value: bigint }
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value)
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value)
  }
  const out = new Map<string, bigint>()
  for (const [addr, bal] of balances) {
    if (bal > 0n && !exclude.has(addr.toLowerCase())) out.set(addr, bal)
  }
  return out
}

async function main() {
  const { flags, yes } = parseArgs()

  const vault = flags.vault ? getAddress(flags.vault) : undefined
  const token = flags.token ? getAddress(flags.token) : undefined
  const currencies = (flags.currency ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(getAddress)
  const fromBlockArg = flags['from-block']
  if (!vault || !token || currencies.length === 0 || fromBlockArg === undefined) {
    throw new Error('Required: --vault 0x... --token 0x... --currency 0x...[,0x...] --from-block N')
  }
  const fromBlock = BigInt(fromBlockArg)
  const slippagePct = flags.slippage ? Number(flags.slippage) : 2
  const extraExclude = new Set((flags.exclude ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))

  const rpcUrl = (process.env.RPC_URL || '').trim()
  if (!rpcUrl) throw new Error('Set RPC_URL (e.g. http://127.0.0.1:8545 for a local Anvil run, or a real Arc RPC).')
  const key = (process.env.KEEPER_PRIVATE_KEY || '').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Set KEEPER_PRIVATE_KEY in .env.local (0x + 64 hex chars). Never pass it as a CLI arg or paste it in chat.')
  }
  const account = privateKeyToAccount(key as Hex)

  const probe = createPublicClient({ transport: http(rpcUrl) })
  const chainId = await probe.getChainId()
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  console.log('RPC:', rpcUrl, '(chainId', chainId + ')')
  console.log('keeper address:', account.address)
  console.log('vault:', vault)
  console.log('token:', token)

  const [hook, poolManagerAddr, creator, vaultOwner, mode, rotateIndex, basketLen] = await Promise.all([
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'hook' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'poolManager' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'creator' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'owner' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'mode' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'rotateIndex' }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'basketLength' }),
  ])
  console.log('hook:', hook, '| poolManager:', poolManagerAddr, '| creator:', creator, '| vault owner:', vaultOwner)
  const isKeeperTheOwner = (vaultOwner as string).toLowerCase() === account.address.toLowerCase()
  console.log('mode:', mode === 0 ? 'AllAtOnce' : 'Rotating', '| rotateIndex:', rotateIndex, '| basket size:', basketLen)
  if (!isKeeperTheOwner) {
    console.log(`\n⚠ your address is NOT this vault's owner (owner is ${vaultOwner}) — disperse() will revert; pull()/convert() are permissionless and will still work.`)
  }

  const basket: BasketEntry[] = []
  for (let i = 0n; i < (basketLen as bigint); i++) {
    const [asset, weightBps, poolKey] = (await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'basket',
      args: [i],
    })) as unknown as [Address, number, PoolKeyTuple]
    basket.push({ asset, weightBps, poolKey })
  }
  for (const b of basket) {
    const [sym, dec] = await Promise.all([
      publicClient.readContract({ address: b.asset, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
      publicClient.readContract({ address: b.asset, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ])
    console.log(`  basket asset: ${b.asset} (${sym}, ${dec}dp) weight ${b.weightBps / 100}% pool ${b.poolKey.currency0}/${b.poolKey.currency1}`)
  }
  if (basket.length === 0) throw new Error('This vault has no basket configured yet — creator must call setBasket() first.')

  console.log('\n── per-currency plan ──')
  const plans: { currency: Address; owed: bigint; convertible: boolean; minOuts: bigint[] }[] = []
  for (const currency of currencies) {
    const owed = (await publicClient.readContract({ address: hook as Address, abi: HOOK_ABI, functionName: 'owed', args: [vault, currency] })) as bigint
    const pendingAlready = (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'pendingConvert', args: [currency] })) as bigint
    const totalToConvert = owed + pendingAlready

    const relevantAssets = mode === 0 ? basket : [basket[Number(rotateIndex)]]
    const convertible = relevantAssets.every(
      (b) => b.poolKey.currency0.toLowerCase() === currency.toLowerCase() || b.poolKey.currency1.toLowerCase() === currency.toLowerCase(),
    )

    console.log(`\ncurrency ${currency}: owed-in-hook ${owed} + already-pending ${pendingAlready} = ${totalToConvert} to convert`)
    if (!convertible) {
      console.log('  ✗ NOT convertible — at least one basket asset in scope has no pool paired with this currency. Will pull() (moves it into pendingConvert) but skip convert().')
      plans.push({ currency, owed, convertible: false, minOuts: [] })
      continue
    }
    if (totalToConvert === 0n) {
      console.log('  nothing accrued yet — skipping.')
      plans.push({ currency, owed: 0n, convertible: true, minOuts: [] })
      continue
    }

    const minOuts: bigint[] = []
    if (mode === 0) {
      let distributed = 0n
      for (let i = 0; i < basket.length; i++) {
        const amtIn = i === basket.length - 1 ? totalToConvert - distributed : (totalToConvert * BigInt(basket[i].weightBps)) / 10_000n
        distributed += amtIn
        const poolId = computePoolId(basket[i].poolKey)
        const sqrtPriceX96 = await readSlot0SqrtPriceX96(publicClient, poolManagerAddr as Address, poolId)
        const fromIsCurrency0 = basket[i].poolKey.currency0.toLowerCase() === currency.toLowerCase()
        const est = amtIn > 0n ? estimateAmountOut(amtIn, sqrtPriceX96, fromIsCurrency0) : 0n
        const minOut = (est * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n
        minOuts.push(minOut)
        console.log(`  -> ${basket[i].asset}: amountIn ${amtIn}, live-price estimate ${est}, minOut (${slippagePct}% floor) ${minOut}`)
      }
    } else {
      const b = basket[Number(rotateIndex)]
      const poolId = computePoolId(b.poolKey)
      const sqrtPriceX96 = await readSlot0SqrtPriceX96(publicClient, poolManagerAddr as Address, poolId)
      const fromIsCurrency0 = b.poolKey.currency0.toLowerCase() === currency.toLowerCase()
      const est = estimateAmountOut(totalToConvert, sqrtPriceX96, fromIsCurrency0)
      const minOut = (est * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n
      minOuts.push(minOut)
      console.log(`  -> (rotating -> ${b.asset}): amountIn ${totalToConvert}, live-price estimate ${est}, minOut (${slippagePct}% floor) ${minOut}`)
    }
    plans.push({ currency, owed, convertible: true, minOuts })
  }

  console.log('\n── holder balances ──')
  const exclude = new Set(
    [vault, hook as Address, poolManagerAddr as Address, '0x0000000000000000000000000000000000000000']
      .map((a) => a.toLowerCase())
      .concat([...extraExclude]),
  )
  const holders = await scanHolderBalances(publicClient, token, fromBlock, exclude)
  const totalHeld = [...holders.values()].reduce((a, b) => a + b, 0n)
  console.log(`${holders.size} real holders found (excluding vault/hook/poolManager/zero-address), ${totalHeld} raw units held between them`)
  if (holders.size === 0) console.log('  (nothing to disperse to yet even after converting — no eligible holders found)')

  console.log('\n── projected disperse batches (pro-rata by current balance; run again after convert() for the real pendingDistribution) ──')
  for (const b of basket) {
    const pendingNow = (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'pendingDistribution', args: [b.asset] })) as bigint
    const plannedAdd = plans
      .filter((p) => p.convertible)
      .reduce((sum, p, idx) => {
        const relevantAssets = mode === 0 ? basket : [basket[Number(rotateIndex)]]
        const assetIdx = relevantAssets.findIndex((x) => x.asset === b.asset)
        return assetIdx === -1 ? sum : sum + (p.minOuts[assetIdx] ?? 0n)
        // NB: uses each leg's minOut as a conservative stand-in for the real convert() output,
        // which is only known after the swap actually executes.
      }, 0n)
    const projected = pendingNow + plannedAdd
    if (projected === 0n || totalHeld === 0n) continue
    console.log(`\n${b.asset}: pendingDistribution now ${pendingNow} + conservative projected ${plannedAdd} = ${projected}`)
    let shown = 0
    for (const [addr, bal] of holders) {
      const share = (projected * bal) / totalHeld
      if (share > 0n && shown < 10) {
        console.log(`   ${addr}: ${share} (${((Number(bal) / Number(totalHeld)) * 100).toFixed(2)}% of held supply)`)
        shown++
      }
    }
    if (holders.size > 10) console.log(`   ... and ${holders.size - 10} more`)
  }

  if (!yes) {
    console.log('\nDry run only — nothing sent. Re-run with --yes once this looks right.')
    return
  }

  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  for (const plan of plans) {
    if (plan.owed === 0n) continue
    console.log(`\nPulling ${plan.currency}...`)
    const { request: pullReq } = await publicClient.simulateContract({
      account,
      address: vault,
      abi: VAULT_ABI,
      functionName: 'pull',
      args: [plan.currency],
    })
    const pullHash = await walletClient.writeContract(pullReq)
    console.log('  tx:', pullHash)
    await publicClient.waitForTransactionReceipt({ hash: pullHash, timeout: 120_000 })

    if (!plan.convertible) {
      console.log('  (not convertible with the current basket — leaving it in pendingConvert)')
      continue
    }
    console.log(`Converting ${plan.currency}...`)
    const { request: convertReq } = await publicClient.simulateContract({
      account,
      address: vault,
      abi: VAULT_ABI,
      functionName: 'convert',
      args: [plan.currency, plan.minOuts],
    })
    const convertHash = await walletClient.writeContract(convertReq)
    console.log('  tx:', convertHash)
    await publicClient.waitForTransactionReceipt({ hash: convertHash, timeout: 120_000 })
  }

  if (!isKeeperTheOwner) {
    console.log("\nSkipping disperse() — your address is not this vault's owner. Pull/convert are done; ask the owner to disperse, or re-run with that key.")
    return
  }

  console.log('\n── dispersing real converted balances (re-read fresh from chain, not the pre-convert estimate) ──')
  for (const b of basket) {
    const pendingFinal = (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'pendingDistribution', args: [b.asset] })) as bigint
    if (pendingFinal === 0n || totalHeld === 0n || holders.size === 0) continue
    const addrs: Address[] = []
    const amounts: bigint[] = []
    let distributed = 0n
    let i = 0
    for (const [addr, bal] of holders) {
      i++
      const isLast = i === holders.size
      const amt = isLast ? pendingFinal - distributed : (pendingFinal * bal) / totalHeld
      distributed += amt
      if (amt > 0n) {
        addrs.push(getAddress(addr))
        amounts.push(amt)
      }
    }
    console.log(`\nDispersing ${b.asset}: ${pendingFinal} across ${addrs.length} holders...`)
    const { request } = await publicClient.simulateContract({
      account,
      address: vault,
      abi: VAULT_ABI,
      functionName: 'disperse',
      args: [b.asset, addrs, amounts],
    })
    const hash = await walletClient.writeContract(request)
    console.log('  tx:', hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    console.log('  confirmed in block', receipt.blockNumber, 'status', receipt.status)
  }
}

main().catch((e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
