/**
 * ArcFun MCP venue helpers. Agents read the pad and get unsigned txs.
 * Signing is Circle Agent Stack (Agent Wallet / CLI), not this server.
 * Runtime is Eve (or any MCP client).
 */
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from 'viem'
import {
  ARC,
  ARC_CHAIN_ID,
  ARC_CREATION_FEE_WEI,
  ARC_INSTANT_CREATE_GAS,
  ARC_IS_TESTNET,
  arcCreationFeeWeiFor,
} from './contracts-arc'
import { buildCreateTokenMemeInstantArc } from './arc-instant-launchpad'
import {
  ARC_REFLECTION_CREATE_GAS,
  buildCreateTokenReflectionArc,
} from './arc-reflection-launchpad'
import {
  buildArcBuy,
  buildArcSell,
  findArcPoolFee,
  encodeApprove,
  formatUsdc,
  minOutFromSlippage,
  parseUsdc,
  quoteArcBuy,
  quoteArcSell,
  arcSwapSpender,
  withRecipient,
} from './arc-swap'
import { buildArcCatalog, fetchArcPoolToken, getArcPoolLiquidityUsdc } from './arc-instant-tokens'
import { fetchArcTrades } from './arc-trades'
import { fetchEvmHolders } from './evm-holders'
import { buildCandles, RANGE_BUCKET_SEC } from './candles'
import { isHiddenToken, isReflectionToken, type PoolToken } from './tokens'
import { bigintReplacer } from './json-safe'

export const CIRCLE_STACK = {
  product: 'Circle Agent Stack',
  wallets: 'https://developers.circle.com/agent-stack/agent-wallets',
  cli: 'https://developers.circle.com/agent-stack/circle-cli/command-reference',
  policies: 'https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies',
  skills: 'https://developers.circle.com/ai/skills',
  setupSkill: 'https://agents.circle.com/skills/setup.md',
  marketplace: 'https://agents.circle.com/services',
} as const

export const EVE_RUNTIME = {
  product: 'Eve',
  docs: 'https://eve.dev/docs/getting-started',
  connections: 'https://eve.dev/docs/connections/mcp',
  tools: 'https://eve.dev/docs/tools',
  sample: 'https://www.arcfun.co/eve/README.md',
} as const

export function circleChainFlag() {
  return ARC_IS_TESTNET ? 'ARC-TESTNET' : 'ARC'
}

export const ARCFUN_MCP = {
  name: 'arcfun',
  version: '1.1.0',
  chainId: ARC_CHAIN_ID,
  chain: 'Arc',
  venue: 'https://www.arcfun.co',
  mcpUrl: 'https://www.arcfun.co/api/mcp',
  stack: {
    venue: 'ArcFun Instant / Instant Reflection on Uniswap V3 TOKEN/USDC',
    wallet: 'Circle Agent Stack (Agent Wallets, Circle CLI, spend policies)',
    agent: 'Eve (MCP connection, tools, approval: always on submit)',
    alsoWorksWith: ['Claude Code', 'Cursor', 'Codex', 'OpenClaw'],
    payments: 'USDC on Arc. Native gas is USDC. Circle nanopayments / x402 optional for agent budgets.',
  },
} as const

export function mcpJson(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, bigintReplacer, 2) }],
  }
}

export function mcpError(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error)?.message ?? String(e) }) }],
    isError: true as const,
  }
}

function requireAddr(raw: string, label: string): Address {
  const v = (raw || '').trim()
  if (!isAddress(v)) throw new Error(`invalid ${label}`)
  return v as Address
}

function encodeCall(abi: readonly unknown[], functionName: string, args: unknown[]): `0x${string}` {
  return (encodeFunctionData as (opts: {
    abi: readonly unknown[]
    functionName: string
    args: unknown[]
  }) => `0x${string}`)({ abi, functionName, args })
}

export function policyAllowlist(wallet?: string) {
  const contracts = [
    ARC.INSTANT_FACTORY,
    ARC.REFLECTION_FACTORY,
    ARC.INSTANT_LOCKER,
    ARC.REFLECTION_LOCKER,
    ARC.USDC,
    ARC.UNI_ROUTER,
    ARC.FEE_ROUTER,
    ARC.UNI_FACTORY,
  ]
  const chain = circleChainFlag()
  const addr = wallet && isAddress(wallet) ? wallet : '$CIRCLE_WALLET_ADDRESS'
  return {
    chainId: ARC_CHAIN_ID,
    circleChain: chain,
    nativeCurrency: 'USDC',
    allowContracts: contracts,
    circle: {
      stack: CIRCLE_STACK.product,
      login: 'circle wallet login you@example.com',
      list: `circle wallet list --chain ${chain} --type agent`,
      balance: `circle wallet balance --address ${addr} --chain ${chain}`,
      dailyLimit: `circle wallet limit set --address ${addr} --chain ${chain} --policy-type stablecoin --per-tx 250 --daily 1000 --weekly 3000 --monthly 8000`,
      contractAllowlist: `circle wallet limit set --address ${addr} --chain ${chain} --policy-type contract --rule-type contract-allowlist --targets "[${contracts.join(',')}]"`,
    },
    note:
      'Circle Agent Wallet policies. Cap daily USDC. Allowlist only these contracts. Do not grant unlimited spend.',
  }
}

function circleArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return v
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
}

function shellQuote(s: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function circleExecute(opts: {
  signature: string
  args: unknown[]
  contract: string
  wallet?: string
  valueWei?: bigint
}) {
  const chain = circleChainFlag()
  const wallet = opts.wallet && isAddress(opts.wallet) ? opts.wallet : '$CIRCLE_WALLET_ADDRESS'
  const args = opts.args.map(circleArg)
  const argv = [
    'circle',
    'wallet',
    'execute',
    opts.signature,
    ...args,
    '--contract',
    opts.contract,
    '--address',
    wallet,
    '--chain',
    chain,
    '--output',
    'json',
  ]
  if (opts.valueWei && opts.valueWei > 0n) {
    argv.push('--amount', formatUnits(opts.valueWei, 18))
  }
  return {
    stack: CIRCLE_STACK.product,
    chain,
    argv,
    shell: argv.map(shellQuote).join(' '),
  }
}

function slimToken(t: PoolToken) {
  const addr = t.coinType || t.poolId
  return {
    address: addr,
    name: t.name,
    symbol: t.symbol,
    kind: isReflectionToken(t) ? 'reflection' : t.launchKind || 'instant',
    priceUsdc: t.currentPrice,
    marketCapUsd: t.marketCap,
    volume24hUsd: t.volume24h ?? t.volume1h ?? 0,
    priceChange24h: t.priceChange24h,
    liquidityUsdc: t.liquidityQuoteUsd ?? null,
    imageUrl: t.imageUrl || t.logoUrl || null,
    twitter: t.twitter || null,
    telegram: t.telegram || null,
    website: t.website || null,
    creator: t.creator,
    pool: t.instantMeta?.uniPool || null,
    url: addr ? `https://www.arcfun.co/token/${addr}` : null,
  }
}

export async function mcpListTokens(limit = 40) {
  let { tokens, source } = await buildArcCatalog()
  tokens = tokens.filter((t) => !isHiddenToken(t.coinType ?? t.poolId))
  try {
    const { enrichTokensWithIndexVolume } = await import('./arc-indexer/run')
    tokens = await enrichTokensWithIndexVolume(tokens)
  } catch {
    /* optional */
  }
  tokens.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
  const n = Math.min(Math.max(1, limit), 80)
  return {
    stack: ARCFUN_MCP.stack,
    source,
    count: tokens.length,
    tokens: tokens.slice(0, n).map(slimToken),
  }
}

export async function mcpGetToken(address: string) {
  const token = requireAddr(address, 'token')
  if (isHiddenToken(token)) throw new Error('token not listed')
  let pool = await fetchArcPoolToken(token)
  if (!pool) throw new Error('token not found on ArcFun')
  try {
    const { enrichTokensWithIndexVolume } = await import('./arc-indexer/run')
    ;[pool] = await enrichTokensWithIndexVolume([pool])
  } catch {
    /* optional */
  }
  try {
    const liq = await getArcPoolLiquidityUsdc(token, pool.instantMeta?.uniPool as Address | undefined, pool.currentPrice)
    if (liq) {
      pool = { ...pool, liquidityUsd: liq.tvlUsd, liquidityQuoteUsd: liq.usdc }
    }
  } catch {
    /* optional */
  }
  return slimToken(pool)
}

export async function mcpQuote(side: 'buy' | 'sell', address: string, amount: string) {
  const token = requireAddr(address, 'token')
  if (isHiddenToken(token)) throw new Error('token not listed')
  const pool = await fetchArcPoolToken(token)
  if (!pool) throw new Error('token not found')
  const dec = isReflectionToken(pool) ? 6 : 18
  if (side === 'buy') {
    const usdcIn = parseUsdc(amount)
    const out = await quoteArcBuy(token, usdcIn)
    if (out == null) throw new Error('quote failed (no pool or quoter error)')
    return {
      side: 'buy',
      token,
      symbol: pool.symbol,
      amountIn: amount,
      amountInAsset: 'USDC',
      amountOut: formatUnits(out, dec),
      amountOutAsset: pool.symbol,
      minOut: formatUnits(minOutFromSlippage(out, 150), dec),
      slippageBps: 150,
      poolFee: '1%',
    }
  }
  const tokenIn = parseUnits(String(amount), dec)
  const out = await quoteArcSell(token, tokenIn)
  if (out == null) throw new Error('quote failed (no pool or quoter error)')
  return {
    side: 'sell',
    token,
    symbol: pool.symbol,
    amountIn: amount,
    amountInAsset: pool.symbol,
    amountOut: formatUsdc(out),
    amountOutAsset: 'USDC',
    minOut: formatUsdc(minOutFromSlippage(out, 150)),
    slippageBps: 150,
    poolFee: '1%',
  }
}

export async function mcpHolders(address: string) {
  const token = requireAddr(address, 'token')
  if (isHiddenToken(token)) throw new Error('token not listed')
  const pool = await fetchArcPoolToken(token)
  if (!pool) throw new Error('token not found')
  const factory = isReflectionToken(pool) ? ARC.REFLECTION_FACTORY : ARC.INSTANT_FACTORY
  const locker = isReflectionToken(pool) ? ARC.REFLECTION_LOCKER : ARC.INSTANT_LOCKER
  const trades = await fetchArcTrades(token)
  const seed = Array.from(
    new Set(
      [
        ...trades.trades.map((t) => t.trader.toLowerCase()),
        pool.creator?.toLowerCase(),
        factory.toLowerCase(),
        locker.toLowerCase(),
      ].filter(Boolean) as string[],
    ),
  )
  return fetchEvmHolders('arc', token, {
    seedAddresses: seed,
    excludeAddresses: [factory, locker, ...(pool.instantMeta?.uniPool ? [pool.instantMeta.uniPool] : [])],
    creatorAddress: pool.creator,
  })
}

export async function mcpCandles(address: string, interval: '5M' | '15M' | '1H' | '1D' = '5M') {
  const token = requireAddr(address, 'token')
  if (isHiddenToken(token)) throw new Error('token not listed')
  const pool = await fetchArcPoolToken(token)
  if (!pool) throw new Error('token not found')
  const tape = await fetchArcTrades(token, { limit: 400 })
  const candles = buildCandles(tape.trades, RANGE_BUCKET_SEC[interval], pool.currentPrice)
  return {
    token,
    symbol: pool.symbol,
    interval,
    count: candles.length,
    candles: candles.slice(-120),
  }
}

const FN_SIG: Record<string, string> = {
  approve: 'approve(address,uint256)',
  createTokenMemeInstantQuote: 'createTokenMemeInstantQuote(string,string,uint256)',
  createTokenMemeInstantQuoteTo: 'createTokenMemeInstantQuoteTo(string,string,uint256,address)',
  createTokenReflectionInstant: 'createTokenReflectionInstant(string,string,address,uint256)',
  createTokenReflectionInstantTo: 'createTokenReflectionInstantTo(string,string,address,uint256,address)',
  swapExactInput: 'swapExactInput(address,address,address,uint24,uint256,uint256)',
  exactInputSingle: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
}

type PreparedStep = {
  step: number
  kind: string
  to: Address
  data: `0x${string}`
  value: string
  gas?: string
  description: string
  functionSignature: string
  args: string[]
  circle: ReturnType<typeof circleExecute>
  eve: { submitTool: 'submit_prepared_tx'; approval: 'always' }
}

function preparedStep(p: {
  step: number
  kind: string
  to: Address
  data: `0x${string}`
  valueWei?: bigint
  gas?: string
  description: string
  functionName: string
  args: unknown[]
  wallet?: string
}): PreparedStep {
  const valueWei = p.valueWei ?? 0n
  const functionSignature = FN_SIG[p.functionName] || `${p.functionName}()`
  return {
    step: p.step,
    kind: p.kind,
    to: p.to,
    data: p.data,
    value: valueWei.toString(),
    gas: p.gas,
    description: p.description,
    functionSignature,
    args: p.args.map(circleArg),
    circle: circleExecute({
      signature: functionSignature,
      args: p.args,
      contract: p.to,
      wallet: p.wallet,
      valueWei,
    }),
    eve: { submitTool: 'submit_prepared_tx', approval: 'always' },
  }
}

export async function mcpPrepareLaunch(input: {
  name: string
  symbol: string
  kind: 'instant' | 'reflection'
  firstBuyUsdc?: string
  rewardsWallet?: string
  rewardToken?: string
  wallet?: string
}) {
  const name = input.name.trim()
  const symbol = input.symbol.trim().toUpperCase()
  if (name.length < 1 || name.length > 32) throw new Error('name must be 1-32 chars')
  if (symbol.length < 1 || symbol.length > 12) throw new Error('symbol must be 1-12 chars')
  const firstBuy = parseUsdc(input.firstBuyUsdc || '0')
  const wallet = input.wallet && isAddress(input.wallet) ? (input.wallet as Address) : undefined
  const rewards =
    input.rewardsWallet && isAddress(input.rewardsWallet) ? (input.rewardsWallet as Address) : undefined
  const feeWei = arcCreationFeeWeiFor(wallet)
  const steps: PreparedStep[] = []

  if (input.kind === 'reflection') {
    const reward = (input.rewardToken && isAddress(input.rewardToken)
      ? input.rewardToken
      : ARC.USDC) as Address
    const call = buildCreateTokenReflectionArc(name, symbol, reward, firstBuy, feeWei, rewards)
    if (firstBuy > 0n) {
      steps.push(
        preparedStep({
          step: 1,
          kind: 'approve',
          to: ARC.USDC,
          data: encodeApprove(ARC.USDC, call.address, firstBuy),
          description: `Approve ${formatUsdc(firstBuy)} USDC to Reflection factory for first buy`,
          functionName: 'approve',
          args: [call.address, firstBuy],
          wallet,
        }),
      )
    }
    steps.push(
      preparedStep({
        step: steps.length + 1,
        kind: 'create',
        to: call.address,
        data: encodeCall(call.abi, call.functionName, call.args),
        valueWei: call.value ?? 0n,
        gas: ARC_REFLECTION_CREATE_GAS.toString(),
        description: `Launch Instant Reflection ${symbol} (50% holders / 25% creator / 25% platform)`,
        functionName: call.functionName,
        args: call.args,
        wallet,
      }),
    )
  } else {
    const call = buildCreateTokenMemeInstantArc(name, symbol, firstBuy, feeWei, rewards)
    if (firstBuy > 0n) {
      steps.push(
        preparedStep({
          step: 1,
          kind: 'approve',
          to: ARC.USDC,
          data: encodeApprove(ARC.USDC, call.address, firstBuy),
          description: `Approve ${formatUsdc(firstBuy)} USDC to Instant factory for first buy`,
          functionName: 'approve',
          args: [call.address, firstBuy],
          wallet,
        }),
      )
    }
    steps.push(
      preparedStep({
        step: steps.length + 1,
        kind: 'create',
        to: call.address,
        data: encodeCall(call.abi, call.functionName, call.args),
        valueWei: call.value ?? 0n,
        gas: ARC_INSTANT_CREATE_GAS.toString(),
        description: `Launch Instant meme ${symbol} (70% creator / 30% platform)`,
        functionName: call.functionName,
        args: call.args,
        wallet,
      }),
    )
  }

  return {
    unsigned: true,
    signer: CIRCLE_STACK.product,
    stack: ARCFUN_MCP.stack,
    eve: {
      runtime: EVE_RUNTIME.product,
      afterPrepare:
        'Submit each step with Eve submit_prepared_tx (approval: always). That tool runs circle wallet execute.',
      sample: EVE_RUNTIME.sample,
    },
    circle: {
      product: CIRCLE_STACK.product,
      chain: circleChainFlag(),
      docs: CIRCLE_STACK,
    },
    chainId: ARC_CHAIN_ID,
    creationFeeNativeWei: (feeWei || ARC_CREATION_FEE_WEI).toString(),
    firstBuyUsdc6: firstBuy.toString(),
    policy: policyAllowlist(wallet),
    steps,
  }
}

export async function mcpPrepareSwap(input: {
  token: string
  side: 'buy' | 'sell'
  amount: string
  wallet: string
  slippageBps?: number
}) {
  const token = requireAddr(input.token, 'token')
  const wallet = requireAddr(input.wallet, 'wallet')
  if (isHiddenToken(token)) throw new Error('token not listed')
  const pool = await fetchArcPoolToken(token)
  if (!pool) throw new Error('token not found')
  const slip = Math.min(1000, Math.max(10, input.slippageBps ?? 150))
  const dec = isReflectionToken(pool) ? 6 : 18
  const spender = arcSwapSpender()
  const steps: PreparedStep[] = []

  if (input.side === 'buy') {
    const usdcIn = parseUsdc(input.amount)
    if (usdcIn <= 0n) throw new Error('amount must be > 0')
    const quoted = await quoteArcBuy(token, usdcIn)
    if (quoted == null) throw new Error('quote failed')
    const minOut = minOutFromSlippage(quoted, slip)
    const poolFee = (await findArcPoolFee(token)) ?? undefined
    let call = buildArcBuy(token, usdcIn, minOut, poolFee)
    call = withRecipient(call, wallet)
    steps.push(
      preparedStep({
        step: 1,
        kind: 'approve',
        to: ARC.USDC,
        data: encodeApprove(ARC.USDC, spender, usdcIn),
        description: `Approve ${formatUsdc(usdcIn)} USDC to ${spender}`,
        functionName: 'approve',
        args: [spender, usdcIn],
        wallet,
      }),
    )
    steps.push(
      preparedStep({
        step: 2,
        kind: 'swap',
        to: call.address,
        data: encodeCall(call.abi, call.functionName, call.args),
        description: `Buy ${pool.symbol} with ${formatUsdc(usdcIn)} USDC (min out ${formatUnits(minOut, dec)})`,
        functionName: call.functionName,
        args: call.args,
        wallet,
      }),
    )
    return {
      unsigned: true,
      signer: CIRCLE_STACK.product,
      stack: ARCFUN_MCP.stack,
      eve: {
        runtime: EVE_RUNTIME.product,
        afterPrepare:
          'Submit approve, then swap, via Eve submit_prepared_tx with human approval. It runs circle wallet execute.',
        sample: EVE_RUNTIME.sample,
      },
      circle: {
        product: CIRCLE_STACK.product,
        chain: circleChainFlag(),
        docs: CIRCLE_STACK,
      },
      chainId: ARC_CHAIN_ID,
      quote: {
        amountIn: formatUsdc(usdcIn),
        amountOut: formatUnits(quoted, dec),
        minOut: formatUnits(minOut, dec),
        slippageBps: slip,
      },
      policy: policyAllowlist(wallet),
      steps,
    }
  }

  const tokenIn = parseUnits(String(input.amount), dec)
  if (tokenIn <= 0n) throw new Error('amount must be > 0')
  const quoted = await quoteArcSell(token, tokenIn)
  if (quoted == null) throw new Error('quote failed')
  const minOut = minOutFromSlippage(quoted, slip)
  const sellPoolFee = (await findArcPoolFee(token)) ?? undefined
  const call = buildArcSell(token, tokenIn, minOut, wallet, sellPoolFee)
  steps.push(
    preparedStep({
      step: 1,
      kind: 'approve',
      to: token,
      data: encodeApprove(token, spender, tokenIn),
      description: `Approve ${input.amount} ${pool.symbol} to ${spender}`,
      functionName: 'approve',
      args: [spender, tokenIn],
      wallet,
    }),
  )
  steps.push(
    preparedStep({
      step: 2,
      kind: 'swap',
      to: call.address,
      data: encodeCall(call.abi, call.functionName, call.args),
      description: `Sell ${input.amount} ${pool.symbol} for USDC (min out ${formatUsdc(minOut)})`,
      functionName: call.functionName,
      args: call.args,
      wallet,
    }),
  )
  return {
    unsigned: true,
    signer: CIRCLE_STACK.product,
    stack: ARCFUN_MCP.stack,
    eve: {
      runtime: EVE_RUNTIME.product,
      afterPrepare:
        'Submit approve, then swap, via Eve submit_prepared_tx with human approval. It runs circle wallet execute.',
      sample: EVE_RUNTIME.sample,
    },
    circle: {
      product: CIRCLE_STACK.product,
      chain: circleChainFlag(),
      docs: CIRCLE_STACK,
    },
    chainId: ARC_CHAIN_ID,
    quote: {
      amountIn: input.amount,
      amountOut: formatUsdc(quoted),
      minOut: formatUsdc(minOut),
      slippageBps: slip,
    },
    policy: policyAllowlist(wallet),
    steps,
  }
}

export function mcpAbout() {
  return {
    ...ARCFUN_MCP,
    policy: policyAllowlist(),
    howTo: {
      connectMcp: {
        url: ARCFUN_MCP.mcpUrl,
        clients: ['Eve (defineMcpClientConnection)', 'Claude Code / Desktop', 'Cursor', 'Codex', 'OpenClaw'],
      },
      circle: {
        ...CIRCLE_STACK,
        chain: circleChainFlag(),
        setupPrompt:
          'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.',
        setup:
          'Install Circle CLI. Create or login to a Circle Agent Wallet. Fund USDC on Arc. Set a daily spend cap and a contract allowlist (see policy.circle). Sign each prepared step with `circle wallet execute`. This MCP never holds keys.',
        signEachStep: 'Use the `circle.shell` string on each prepared step, or Eve submit_prepared_tx.',
      },
      eve: {
        ...EVE_RUNTIME,
        pattern:
          'npx eve@latest init. Copy public/eve/connections/arcfun.ts, tools/submit_prepared_tx.ts, instructions.md, and skills/arcfun.md into agent/. Set CIRCLE_WALLET_ADDRESS. Human approval is required on every broadcast.',
      },
    },
    tools: [
      'about',
      'list_tokens',
      'get_token',
      'quote_buy',
      'quote_sell',
      'get_holders',
      'get_candles',
      'prepare_launch',
      'prepare_swap',
    ],
  }
}
