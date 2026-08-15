/**
 * Eve tool: send one unsigned step from ArcFun prepare_launch / prepare_swap
 * through Circle Agent Stack (`circle wallet execute`).
 *
 * Copy to agent/tools/submit_prepared_tx.ts in an Eve project.
 * Requires Circle CLI on PATH and CIRCLE_WALLET_ADDRESS.
 * approval: always() so a human confirms every broadcast.
 */
import { spawn } from 'node:child_process'
import { defineTool } from 'eve/tools'
import { always } from 'eve/tools/approval'
import { z } from 'zod'

function run(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += String(c)
    })
    child.stderr.on('data', (c) => {
      stderr += String(c)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }))
  })
}

function nativeAmount(valueWei: string): string | null {
  if (!valueWei || valueWei === '0') return null
  const wei = BigInt(valueWei)
  if (wei <= 0n) return null
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole.toString()}.${frac}` : whole.toString()
}

export default defineTool({
  description:
    'Submit one prepared ArcFun transaction (approve, create, or swap) via Circle Agent Stack using `circle wallet execute`. Human approval required. ArcFun MCP does not sign.',
  inputSchema: z.object({
    to: z.string().describe('Contract address'),
    functionSignature: z.string().describe('ABI signature, e.g. approve(address,uint256)'),
    args: z.array(z.string()).default([]).describe('ABI args as strings from the prepared step'),
    value: z.string().default('0').describe('Native USDC wei string (creation fee) or "0"'),
    chainId: z.number().int().describe('5042 (Arc) or 5042002 (Arc testnet)'),
    wallet: z.string().optional().describe('Circle Agent Wallet. Defaults to CIRCLE_WALLET_ADDRESS.'),
    description: z.string().optional(),
  }),
  approval: always(),
  async execute({ to, functionSignature, args, value, chainId, wallet, description }) {
    if (chainId !== 5042 && chainId !== 5042002) {
      throw new Error('ArcFun only on Arc mainnet (5042) or Arc testnet (5042002)')
    }
    const address = wallet || process.env.CIRCLE_WALLET_ADDRESS
    if (!address) {
      throw new Error('Pass wallet or set CIRCLE_WALLET_ADDRESS to your Circle Agent Wallet')
    }
    const chain =
      chainId === 5042002 ? 'ARC-TESTNET' : process.env.CIRCLE_CHAIN || 'ARC'
    const argv = [
      'circle',
      'wallet',
      'execute',
      functionSignature,
      ...args,
      '--contract',
      to,
      '--address',
      address,
      '--chain',
      chain,
      '--output',
      'json',
    ]
    const amount = nativeAmount(value)
    if (amount) argv.push('--amount', amount)

    const result = await run(argv)
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `circle wallet execute failed (${result.code}). Confirm Circle CLI is installed and the wallet is funded on Arc.`,
      )
    }
    let parsed: unknown = result.stdout.trim()
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      /* keep text */
    }
    return {
      submitted: true,
      stack: 'Circle Agent Stack',
      runtime: 'Eve',
      description: description ?? null,
      chain,
      argv,
      result: parsed,
    }
  },
})
