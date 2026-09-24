/**
 * node --experimental-strip-types --import ./scripts/alias-register.mjs --test lib/imsg-buybot.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFunctionData, erc20Abi, parseUnits, toFunctionSelector } from 'viem'
import { parseIntent } from './imsg-buybot/intent.ts'
import { decodeKernelBatch, encodeKernelBatch, KERNEL_EXEC_MODE_BATCH } from './imsg-buybot/kernel.ts'
import { checkBuyCalls, DEFAULT_BUY_POLICY as P } from './imsg-buybot/policy.ts'
import { createBuyBot, phoneKey } from './imsg-buybot/bot.ts'

const EVE = P.token
const RR = P.router.address
const STALE_FEE_ROUTER = '0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088'
const OTHER = '0x000000000000000000000000000000000000dEaD'
const usdc = (n) => parseUnits(String(n), 6)
const E18 = 10n ** 18n

const REF_BUY_ABI = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenOut', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'code', type: 'string' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
]

/** A plan shaped exactly like live.ts builds it; every field overridable to break one rule. */
function plan(usdcIn, o = {}) {
  const quotedOut = o.quotedOut ?? 3_000_000n * E18
  const minOut = o.minOut ?? (quotedOut * 9_900n) / 10_000n
  const router = o.router ?? RR
  const buy = {
    target: router,
    value: o.buyValue ?? 0n,
    data: encodeFunctionData({
      abi: REF_BUY_ABI,
      functionName: 'buy',
      args: [o.token ?? EVE, o.fee ?? 10_000, o.buyAmount ?? usdcIn, o.buyMinOut ?? minOut, o.code ?? ''],
    }),
  }
  const approve = {
    target: o.approveTarget ?? P.usdc,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [o.approveSpender ?? router, o.approveAmount ?? usdcIn],
    }),
  }
  const calls = o.calls ?? (o.noApprove ? [buy] : [approve, buy])
  return { usdcIn, quotedOut, minOut, poolFee: 10_000, platformFeeBps: 100, slippageBps: 100, calls }
}

test('intent grammar: the three buy forms, confirm/cancel/balance, case-insensitive', () => {
  for (const t of ['buy $5 of $eve', 'BUY $5 OF $EVE', 'buy $5 eve', 'buy 5 of eve', 'buy $eve with $5', 'buy $5 of $eve.']) {
    assert.deepEqual(parseIntent(t), { kind: 'buy', usdcIn: usdc(5) }, t)
  }
  assert.deepEqual(parseIntent('buy $2.50 of $eve'), { kind: 'buy', usdcIn: usdc(2.5) })
  assert.equal(parseIntent('YES').kind, 'yes')
  assert.equal(parseIntent(' yes! ').kind, 'yes')
  assert.equal(parseIntent('cancel').kind, 'cancel')
  assert.equal(parseIntent('bal').kind, 'balance')
  assert.equal(parseIntent('balance').kind, 'balance')
  assert.equal(parseIntent('y').kind, 'help')
  assert.equal(parseIntent('hello').kind, 'help')
})

test('intent grammar: other tickers and odd amounts are rejected, never guessed', () => {
  for (const t of ['buy $5 of $pepe', 'buy $1,000 of $eve', 'buy $-5 of $eve', 'buy $abc of $eve', 'buy $5']) {
    assert.equal(parseIntent(t).kind, 'reject', t)
  }
  assert.equal(parseIntent('buy $0 of $eve').kind, 'reject')
})

test('Kernel batch: ERC-7579 execute selector, batch mode, lossless round trip', () => {
  const calls = plan(usdc(5)).calls
  const data = encodeKernelBatch(calls)
  assert.equal(data.slice(0, 10), toFunctionSelector('execute(bytes32,bytes)'))
  assert.equal(data.slice(0, 10), '0xe9ae5c53')
  assert.equal(KERNEL_EXEC_MODE_BATCH.slice(0, 4), '0x01')
  assert.deepEqual(
    decodeKernelBatch(data).map((c) => [c.target.toLowerCase(), c.value, c.data]),
    calls.map((c) => [c.target.toLowerCase(), c.value, c.data]),
  )
})

test('policy: live-shaped approve + ReferralRouter.buy passes; buy-only passes too', () => {
  const p = plan(usdc(5))
  assert.deepEqual(checkBuyCalls(p.calls, p, P, 0n), [])
  const q = plan(usdc(5), { noApprove: true })
  assert.deepEqual(checkBuyCalls(q.calls, q, P, 0n), [])
})

test('policy: every widening of the session key is refused', () => {
  const cases = {
    'stale FeeRouter (env not loaded)': { router: STALE_FEE_ROUTER },
    'other tokenOut': { token: OTHER },
    'other pool fee': { fee: 3000 },
    'amountIn differs from quote': { buyAmount: usdc(6) },
    'minOut differs from quote': { buyMinOut: 1n },
    'referral code from chat': { code: 'gm' },
    'approve larger than quote': { approveAmount: usdc(1_000_000) },
    'approve to another spender': { approveSpender: OTHER },
    'approve on another token': { approveTarget: EVE },
    'native value on buy': { buyValue: 1n },
    'minOut looser than 3%': { minOut: 1n, buyMinOut: 1n },
  }
  for (const [name, o] of Object.entries(cases)) {
    const p = plan(usdc(5), o)
    assert.ok(checkBuyCalls(p.calls, p, P, 0n).length > 0, name)
  }
  const p = plan(usdc(5))
  const extra = [...p.calls, { target: OTHER, value: 0n, data: '0x' }]
  assert.ok(checkBuyCalls(extra, p, P, 0n).length > 0, 'extra call')
  assert.ok(checkBuyCalls([], p, P, 0n).length > 0, 'no calls')
})

test('policy: $1 minimum, $25 per buy, $100 per day', () => {
  const small = plan(usdc(0.5))
  assert.match(checkBuyCalls(small.calls, small, P, 0n).join(), /Minimum/)
  const big = plan(usdc(26))
  assert.match(checkBuyCalls(big.calls, big, P, 0n).join(), /Max per buy/)
  const ok = plan(usdc(25))
  assert.deepEqual(checkBuyCalls(ok.calls, ok, P, usdc(75)), [])
  assert.match(checkBuyCalls(ok.calls, ok, P, usdc(76)).join(), /Daily limit/)
})

function harness(o = {}) {
  let t = Date.parse('2026-09-23T12:00:00Z')
  const submitted = []
  const bot = createBuyBot({
    policy: P,
    quoteBuy: o.quoteBuy ?? (async (usdcIn) => plan(usdcIn)),
    accountOf: () => o.account ?? null,
    balances: async () => ({ usdc: usdc(12.34), token: 5n * E18 }),
    submit: async (s) => {
      submitted.push(s)
      return { dryRun: true }
    },
    now: () => t,
  })
  return { bot, submitted, advance: (ms) => (t += ms) }
}

test('bot: quote → YES submits once; a second YES has nothing to confirm', async () => {
  const { bot, submitted } = harness()
  const q = await bot.handle('u', 'buy $5 of $eve')
  assert.ok(q.quoteId)
  assert.match(q.text, /Buy \$5\.00 USDC → ~3,000,000 \$EVE/)
  assert.match(q.text, /reply YES/)
  const y = await bot.handle('u', 'YES')
  assert.match(y.text, /Dry run/)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].quoteId, q.quoteId)
  assert.deepEqual(decodeKernelBatch(submitted[0].callData).length, 2)
  assert.match((await bot.handle('u', 'yes')).text, /No pending quote/)
  assert.equal(submitted.length, 1)
})

test('bot: expired quotes, cancel, and a new buy replacing the pending one', async () => {
  const { bot, submitted, advance } = harness()
  await bot.handle('u', 'buy $5 of $eve')
  advance(60_001)
  assert.match((await bot.handle('u', 'yes')).text, /expired/)
  await bot.handle('u', 'buy $5 of $eve')
  assert.equal((await bot.handle('u', 'cancel')).text, 'Cancelled.')
  assert.match((await bot.handle('u', 'yes')).text, /No pending quote/)
  const first = await bot.handle('u', 'buy $5 of $eve')
  const second = await bot.handle('u', 'buy $7 of $eve')
  await bot.handle('u', 'yes')
  assert.notEqual(first.quoteId, second.quoteId)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].quoteId, second.quoteId)
  assert.equal(submitted[0].calls.length, 2)
})

test('bot: daily cap counts confirmed buys only, per user, and resets next UTC day', async () => {
  const { bot, advance } = harness()
  for (let i = 0; i < 4; i++) {
    await bot.handle('u', 'buy $25 of $eve')
    assert.match((await bot.handle('u', 'yes')).text, /Dry run/)
  }
  assert.match((await bot.handle('u', 'buy $1 of $eve')).text, /Daily limit/)
  assert.ok((await bot.handle('other', 'buy $25 of $eve')).quoteId)
  advance(12 * 3600_000)
  assert.ok((await bot.handle('u', 'buy $1 of $eve')).quoteId)
})

test('bot: a quote the policy rejects is never offered for YES', async () => {
  const { bot, submitted } = harness({ quoteBuy: async (usdcIn) => plan(usdcIn, { router: STALE_FEE_ROUTER }) })
  const r = await bot.handle('u', 'buy $5 of $eve')
  assert.equal(r.quoteId, undefined)
  assert.ok(r.violations.some((v) => /only ReferralRouter/.test(v)))
  assert.match((await bot.handle('u', 'yes')).text, /No pending quote/)
  assert.equal(submitted.length, 0)
})

test('bot: quote failures and balance without a linked wallet', async () => {
  const { bot } = harness({ quoteBuy: async () => { throw new Error('rpc down') } })
  assert.match((await bot.handle('u', 'buy $5 of $eve')).text, /Couldn't get a quote/)
  assert.match((await bot.handle('u', 'balance')).text, /No wallet linked/)
  const linked = harness({ account: '0x1111111111111111111111111111111111111111' })
  assert.match((await linked.bot.handle('u', 'bal')).text, /\$12\.34 USDC · 5 \$EVE/)
})

test('phoneKey: formatting-insensitive, salt-dependent, refuses an empty salt', () => {
  assert.equal(phoneKey('+1 (555) 010-0100', 's'), phoneKey('+15550100100', 's'))
  assert.notEqual(phoneKey('+15550100100', 's'), phoneKey('+15550100100', 't'))
  assert.throws(() => phoneKey('+15550100100', ''))
})
