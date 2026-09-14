/**
 * node --experimental-strip-types --test lib/eve-fee-split.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('presets sum to 100% with 10% platform floor', async () => {
  const { FEE_SPLIT_PRESETS, splitSum, splitValid, MIN_PLATFORM_BPS } = await import('./eve-fee-split.ts')
  for (const [id, s] of Object.entries(FEE_SPLIT_PRESETS)) {
    assert.equal(splitSum(s), 10_000, id)
    assert.ok(s.platformBps >= MIN_PLATFORM_BPS, id)
    assert.equal(splitValid(s).ok, true, id)
  }
})

test('reflect preset meets the 20% holders floor; creator does not', async () => {
  const { FEE_SPLIT_PRESETS, splitValid, MIN_REFLECT_HOLDERS_BPS } = await import('./eve-fee-split.ts')
  assert.equal(
    splitValid(FEE_SPLIT_PRESETS.reflect, { minHoldersBps: MIN_REFLECT_HOLDERS_BPS }).ok,
    true,
  )
  assert.equal(
    splitValid(FEE_SPLIT_PRESETS.creator, { minHoldersBps: MIN_REFLECT_HOLDERS_BPS }).ok,
    false,
  )
})

test('RWA hides holders by folding them into creator', async () => {
  const { FEE_SPLIT_PRESETS, foldHoldersIntoCreator, splitValid, splitSum } = await import(
    './eve-fee-split.ts'
  )
  const folded = foldHoldersIntoCreator(FEE_SPLIT_PRESETS.reflect)
  assert.equal(folded.holdersBps, 0)
  assert.equal(splitSum(folded), 10_000)
  assert.equal(splitValid(folded, { hideHolders: true }).ok, true)
  assert.equal(splitValid(FEE_SPLIT_PRESETS.reflect, { hideHolders: true }).ok, false)
})

test('matchPreset and fee bounds', async () => {
  const { FEE_SPLIT_PRESETS, matchPreset, splitValid } = await import('./eve-fee-split.ts')
  assert.equal(matchPreset(FEE_SPLIT_PRESETS.scorched), 'scorched')
  const custom = { ...FEE_SPLIT_PRESETS.creator, creatorBps: 6_000, burnBps: 2_000 }
  assert.equal(matchPreset(custom), 'custom')
  assert.equal(splitValid({ ...FEE_SPLIT_PRESETS.creator, feeBps: 29 }).ok, false)
  assert.equal(splitValid({ ...FEE_SPLIT_PRESETS.creator, feeBps: 301 }).ok, false)
  assert.equal(splitValid({ ...FEE_SPLIT_PRESETS.creator, platformBps: 900, creatorBps: 7_100 }).ok, false)
})

test('splitValid iterates legs by key', async () => {
  const { FEE_SPLIT_PRESETS, splitValid } = await import('./eve-fee-split.ts')
  assert.equal(splitValid(FEE_SPLIT_PRESETS.pool).ok, true)
})
