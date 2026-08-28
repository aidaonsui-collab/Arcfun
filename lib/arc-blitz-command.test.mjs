/**
 * node --test lib/arc-blitz-command.test.mjs
 * Loads the TypeScript parser by stripping the two type annotations (no deps).
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ts = readFileSync(join(here, 'arc-blitz-command.ts'), 'utf8')
const js = ts
  .replace(/^export type .*$/gm, '')
  .replace(/: Set<string>/g, '')
  .replace(/\?: string/g, " = ''")
  .replace(/: string/g, '')
  .replace(/: boolean/g, '')
  .replace(': BlitzLaunchCommand | null', '')
const out = join(tmpdir(), 'arc-blitz-command.mjs')
writeFileSync(out, js)
const { parseBlitzLaunchCommand } = await import(pathToFileURL(out).href)

test('Bankr exact phrase: Launch a token Suwappubot ticker Suwappu on base', () => {
  assert.deepEqual(
    parseBlitzLaunchCommand('Launch a token Suwappubot ticker Suwappu on base'),
    { name: 'Suwappubot', symbol: 'SUWAPPU' },
  )
})

test('hello-world negative', () => {
  assert.equal(parseBlitzLaunchCommand('hello world'), null)
})

test('create + mention + on arc still parses', () => {
  assert.deepEqual(
    parseBlitzLaunchCommand('@watch_eve create a token HelloBot ticker HELLO on arc'),
    { name: 'HelloBot', symbol: 'HELLO' },
  )
})

test('launch NAME ticker TICKER without "a token"', () => {
  assert.deepEqual(parseBlitzLaunchCommand('launch FooBar ticker FB'), { name: 'FooBar', symbol: 'FB' })
})

test('missing ticker is ignored', () => {
  assert.equal(parseBlitzLaunchCommand('launch a token Suwappubot on base'), null)
})

test('control characters in the name are ignored', () => {
  assert.equal(parseBlitzLaunchCommand('launch a token Foo\u0000Bar ticker FB'), null)
})

test('denied ticker USDC', () => {
  assert.equal(parseBlitzLaunchCommand('launch a token FakeUSD ticker USDC'), null)
})

test('denied ticker ETH', () => {
  assert.equal(parseBlitzLaunchCommand('launch a token Ethereum ticker ETH'), null)
})

test('denied ticker EVE', () => {
  assert.equal(parseBlitzLaunchCommand('launch a token EveClone ticker EVE'), null)
})
