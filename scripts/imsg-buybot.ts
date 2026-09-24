/**
 * iMessage $EVE buy-bot — Phase 1 dry run (docs/IMESSAGE_EVE_BUY_BOT.md).
 * Live Arc quotes and real Kernel UserOp callData. Never signs, never broadcasts.
 *
 *   npm run imsg-buybot                              # chat as if in Messages
 *   npm run imsg-buybot -- "buy $5 of $eve"          # one message, auto-YES, print the UserOp
 *   npm run imsg-buybot -- --account 0x… "balance"   # read a real wallet (balance + allowance)
 */
import { createInterface } from 'node:readline/promises'
import { isAddress, type Address } from 'viem'
import { entryPoint07Address } from 'viem/account-abstraction'
import { ARC_EXPLORER } from '@/lib/contracts-arc'
import { createBuyBot, type BotReply } from '@/lib/imsg-buybot/bot'
import { quoteEveBuy, readBalances } from '@/lib/imsg-buybot/live'
import { DEFAULT_BUY_POLICY } from '@/lib/imsg-buybot/policy'

const USER = 'cli'

function takeAccount(args: string[]): Address | null {
  const i = args.indexOf('--account')
  if (i < 0) return null
  const v = args[i + 1]
  if (!v || !isAddress(v)) throw new Error('--account needs a 0x address')
  args.splice(i, 2)
  return v
}

function print(r: BotReply) {
  console.log(`bot> ${r.text.replace(/\n/g, '\n     ')}`)
  if (r.violations?.length) {
    console.log('  blocked by policy:')
    for (const v of r.violations) console.log(`   - ${v}`)
  }
  if (!r.submission) return
  const s = r.submission
  console.log(`  unsigned UserOp → EntryPoint v0.7 ${entryPoint07Address}`)
  console.log(`   sender    ${s.sender ?? '(linked Kernel wallet)'}`)
  s.calls.forEach((c, i) => console.log(`   call ${i + 1}    ${c.target}  ${c.data}`))
  console.log(`   callData  ${s.callData}`)
  console.log('   nonce, gas and signature are added at submit (Phase 2). Nothing was sent.')
}

async function main() {
  const args = process.argv.slice(2)
  const account = takeAccount(args)
  const bot = createBuyBot({
    policy: DEFAULT_BUY_POLICY,
    quoteBuy: quoteEveBuy,
    accountOf: () => account,
    balances: readBalances,
    submit: async () => ({ dryRun: true }),
    explorer: ARC_EXPLORER,
  })

  if (args.length) {
    const text = args.join(' ')
    console.log(`you> ${text}`)
    const r = await bot.handle(USER, text)
    print(r)
    if (r.quoteId) {
      console.log('you> YES')
      print(await bot.handle(USER, 'YES'))
    }
    return
  }

  console.log('iMessage $EVE buy-bot — dry run. Type as you would in Messages. Ctrl+C to quit.')
  const piped = !process.stdin.isTTY
  process.stdout.write('\nyou> ')
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim()) {
      if (piped) console.log(line)
      print(await bot.handle(USER, line))
    }
    process.stdout.write('\nyou> ')
  }
  console.log()
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
