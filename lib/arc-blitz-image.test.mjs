/**
 * node --test lib/arc-blitz-image.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blitzTokenImageUrl,
  firstTweetPhoto,
  firstTweetPhotoFromKeys,
  parentTweetId,
  tweetStatusUrl,
} from './arc-blitz-image.ts'

test('prefers photo over video preview', () => {
  assert.equal(
    firstTweetPhoto([
      { type: 'video', preview_image_url: 'https://pbs.twimg.com/vid.jpg' },
      { type: 'photo', url: 'https://pbs.twimg.com/pic.jpg' },
    ]),
    'https://pbs.twimg.com/pic.jpg',
  )
})

test('uses video preview when there is no photo', () => {
  assert.equal(
    firstTweetPhoto([{ type: 'video', preview_image_url: 'https://pbs.twimg.com/vid.jpg' }]),
    'https://pbs.twimg.com/vid.jpg',
  )
})

test('empty media is null, never an avatar', () => {
  assert.equal(firstTweetPhoto([]), null)
  assert.equal(firstTweetPhoto(null), null)
  assert.equal(blitzTokenImageUrl(null), undefined)
  assert.equal(blitzTokenImageUrl(''), undefined)
  assert.equal(blitzTokenImageUrl('https://pbs.twimg.com/profile_images/x.jpg'), undefined)
  assert.equal(blitzTokenImageUrl('https://pbs.twimg.com/media/abc.jpg'), 'https://pbs.twimg.com/media/abc.jpg')
})

test('looks up media keys', () => {
  const byKey = new Map([
    ['m1', { type: 'photo', url: 'https://pbs.twimg.com/a.jpg' }],
  ])
  assert.equal(firstTweetPhotoFromKeys(['m1'], byKey), 'https://pbs.twimg.com/a.jpg')
  assert.equal(firstTweetPhotoFromKeys(['missing'], byKey), null)
})

test('parent id prefers replied_to over quoted', () => {
  assert.equal(
    parentTweetId([
      { type: 'quoted', id: '111' },
      { type: 'replied_to', id: '222' },
    ]),
    '222',
  )
  assert.equal(parentTweetId([{ type: 'quoted', id: '111' }]), '111')
  assert.equal(parentTweetId([{ type: 'retweeted', id: '111' }]), null)
  assert.equal(parentTweetId([]), null)
})

test('status url prefers handle, falls back to /i/status', () => {
  assert.equal(
    tweetStatusUrl('circle', '1539656962916225030'),
    'https://x.com/circle/status/1539656962916225030',
  )
  assert.equal(tweetStatusUrl('', '1539656962916225030'), 'https://x.com/i/status/1539656962916225030')
  assert.equal(tweetStatusUrl('circle', 'nope'), null)
})
