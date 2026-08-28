/**
 * node --test lib/social-href.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { twitterHref, websiteHref } from './social-href.ts'

test('handle becomes an x.com profile', () => {
  assert.equal(twitterHref('circle'), 'https://x.com/circle')
  assert.equal(twitterHref('@Chain0xs'), 'https://x.com/Chain0xs')
})

test('status URL is kept as the original post', () => {
  assert.equal(
    twitterHref('https://x.com/circle/status/1539656962916225030'),
    'https://x.com/circle/status/1539656962916225030',
  )
  assert.equal(
    twitterHref('https://twitter.com/circle/status/1539656962916225030?s=20'),
    'https://x.com/circle/status/1539656962916225030',
  )
})

test('website keeps a status URL', () => {
  assert.equal(
    websiteHref('https://x.com/circle/status/1539656962916225030'),
    'https://x.com/circle/status/1539656962916225030',
  )
})
