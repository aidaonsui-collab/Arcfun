/**
 * Blitz X mention bot — Instant-creates on Arc (never Base).
 *
 * Env (server):
 *   CRON_SECRET              Vercel cron bearer
 *   X_API_KEY                OAuth 1.0a consumer key
 *   X_API_SECRET             OAuth 1.0a consumer secret
 *   X_ACCESS_TOKEN           OAuth 1.0a user access token
 *   X_ACCESS_SECRET          OAuth 1.0a user access token secret
 *   BLITZ_BOT_HANDLE         bot @handle (no @ required)
 *   BLITZ_BOT_KEY            0x private key for Instant mint (omit → prefill /create? reply)
 *   BLITZ_FIRST_BUY_USDC     first-buy USDC amount, default 0
 *   BLITZ_EVE_BURN           EveBurn sink; Instant creator USDC stamps here (no tweet 0x)
 *   BLITZ_MIN_ACCOUNT_DAYS   default 30; 0 disables
 *   BLITZ_MIN_FOLLOWERS      default 50; 0 disables
 *   BLITZ_DAILY_CAP          default 20 Instant creates / UTC day; 0 disables
 *   BLITZ_TICKER_DENY        extra comma-separated tickers

 *   NEXT_PUBLIC_BLITZ_BOT_HANDLE  UI copy (@handle, default watch_eve)
 *   NEXT_PUBLIC_EVE_BURN     same sink, public
 *
 * Never log keys. Never commit secrets.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { kv } from '@vercel/kv'
import { erc20Abi, type Address, type Hex } from 'viem'
import { draftFromTweet, prefillQuery, type BlitzTweet } from './arc-blitz'
import { firstTweetPhotoFromKeys, isRetweetRef, parentTweetId, tweetStatusUrl } from './arc-blitz-image'
import { parseBlitzLaunchCommand } from './arc-blitz-command'
import {
  BLITZ_AUTHOR_TTL_SEC,
  blitzAuthorKey,
  xAccountTooNew,
  xFollowersTooLow,
  takeDailyMintSlot,
} from './arc-blitz-guards'
import { blitzBotPrivateKey, mintOnArc } from './arc-blitz-mint'
import {
  ARC,
  arcPublicClient,
  arcServerWalletClient,
} from './contracts-arc'
import { EVE_BURN_ABI, EVE_POOL_FEE, EVE_TOKEN, eveBurnAddress } from './eve'

const X_API = 'https://api.twitter.com/2'
const TWEET_TTL_SEC = 7 * 24 * 60 * 60
const MAX_AGE_SEC = 15 * 60
const USER_ID_TTL_SEC = 7 * 24 * 60 * 60
const FETCH_MS = 12_000

const TWEET_KEY = (id: string) => `arcfun:blitz:bot:tweet:${id}`
const AUTHOR_KEY = blitzAuthorKey
const AUTHOR_TTL_SEC = BLITZ_AUTHOR_TTL_SEC
const USER_ID_KEY = (handle: string) => `arcfun:blitz:bot:userid:${handle.toLowerCase()}`

type TickResult = {
  ok: true
  skipped?: string
  scanned?: number
  launched?: number
  prefills?: number
  ignored?: number
  cooked?: string
}

const COOK_DUST = 100_000n // 0.1 USDC (6dp)
const COOK_SLIP_BPS = 9000n // 90% of quote

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

type XUser = {
  id: string
  username: string
  name: string
  profile_image_url?: string
  created_at?: string
  public_metrics?: { followers_count?: number }
}
type XMedia = { media_key: string; type: string; url?: string; preview_image_url?: string }
type XTweet = {
  id: string
  text: string
  created_at?: string
  author_id?: string
  in_reply_to_user_id?: string
  referenced_tweets?: { type: string; id: string }[]
  attachments?: { media_keys?: string[] }
}

function env(name: string): string {
  return (process.env[name] || '').trim()
}

function botHandle(): string {
  const h = env('BLITZ_BOT_HANDLE') || env('NEXT_PUBLIC_BLITZ_BOT_HANDLE') || 'watch_eve'
  return h.replace(/^@/, '')
}

function siteOrigin(): string {
  const raw = env('NEXT_PUBLIC_APP_URL') || env('NEXT_PUBLIC_SITE_URL') || 'https://arcfun.co'
  return raw.replace(/\/+$/, '') || 'https://arcfun.co'
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function oauthHeader(method: string, url: string, query: Record<string, string>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: env('X_API_KEY'),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env('X_ACCESS_TOKEN'),
    oauth_version: '1.0',
  }
  const all: Record<string, string> = { ...query, ...oauth }
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`)
    .join('&')
  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`
  const key = `${percentEncode(env('X_API_SECRET'))}&${percentEncode(env('X_ACCESS_SECRET'))}`
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64')
  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(', ')
  )
}

async function xFetch(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<unknown> {
  const url = `${X_API}${path}`
  const qs = new URLSearchParams(query).toString()
  const href = qs ? `${url}?${qs}` : url
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), FETCH_MS)
  try {
    const res = await fetch(href, {
      method,
      headers: {
        Authorization: oauthHeader(method, url, query),
        'User-Agent': 'ArcfunBlitz/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => null)) as unknown
    if (!res.ok) {
      const title =
        json && typeof json === 'object' && json !== null && 'detail' in json
          ? String((json as { detail?: unknown }).detail)
          : `x ${method} ${path} ${res.status}`
      throw new Error(title.slice(0, 200))
    }
    return json
  } finally {
    clearTimeout(t)
  }
}

async function resolveBotUserId(handle: string): Promise<string> {
  const cacheKey = USER_ID_KEY(handle)
  try {
    const hit = await kv.get<string>(cacheKey)
    if (hit) return hit
  } catch {
    /* kv down */
  }
  const body = (await xFetch('GET', `/users/by/username/${encodeURIComponent(handle)}`, {
    'user.fields': 'username',
  })) as { data?: XUser }
  const id = body.data?.id
  if (!id) throw new Error(`No X user @${handle}`)
  try {
    await kv.set(cacheKey, id, { ex: USER_ID_TTL_SEC })
  } catch {
    /* ignore */
  }
  return id
}

function bumpAvatar(url: string): string {
  return url.replace(/_normal\.(jpg|png|webp)$/i, '_400x400.$1')
}

function toBlitzTweet(
  tw: XTweet,
  user: XUser,
  mediaByKey: Map<string, XMedia>,
  tweetsById: Map<string, XTweet>,
): BlitzTweet {
  let image = firstTweetPhotoFromKeys(tw.attachments?.media_keys, mediaByKey)
  if (!image) {
    const parent = tweetsById.get(parentTweetId(tw.referenced_tweets) || '')
    if (parent) image = firstTweetPhotoFromKeys(parent.attachments?.media_keys, mediaByKey)
  }
  const avatar = user.profile_image_url ? bumpAvatar(user.profile_image_url) : ''
  const createdAt = tw.created_at ? Math.floor(new Date(tw.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000)
  return {
    id: tw.id,
    url: `https://x.com/${user.username}/status/${tw.id}`,
    text: tw.text || '',
    createdAt,
    handle: user.username,
    displayName: user.name || user.username,
    avatarUrl: avatar,
    // Token art is tweet / parent-tweet media only. Never the author's X pfp.
    imageUrl: image,
  }
}

function attachSource(
  tweet: BlitzTweet,
  tw: XTweet,
  tweetsById: Map<string, XTweet>,
  users: Map<string, XUser>,
): void {
  const pid = parentTweetId(tw.referenced_tweets)
  if (!pid) return
  const parent = tweetsById.get(pid)
  const authorId = parent?.author_id || tw.in_reply_to_user_id
  const handle = (authorId && users.get(authorId)?.username) || ''
  tweet.sourceHandle = handle || null
  tweet.sourceUrl = tweetStatusUrl(handle, pid)
}

async function fetchTweetPhoto(id: string): Promise<string | null> {
  try {
    const body = (await xFetch('GET', `/tweets/${encodeURIComponent(id)}`, {
      expansions: 'attachments.media_keys',
      'tweet.fields': 'attachments',
      'media.fields': 'url,preview_image_url,type',
    })) as { data?: XTweet; includes?: { media?: XMedia[] } }
    const mediaByKey = new Map((body.includes?.media || []).map((m) => [m.media_key, m]))
    return firstTweetPhotoFromKeys(body.data?.attachments?.media_keys, mediaByKey)
  } catch {
    return null
  }
}

async function cookEveBurn(pk: Hex): Promise<string | undefined> {
  const sink = eveBurnAddress()
  if (!sink) return undefined
  try {
    const client = arcPublicClient()
    const wallet = arcServerWalletClient(pk)
    const bal = (await client.readContract({
      address: ARC.USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [sink],
    })) as bigint
    if (bal < COOK_DUST) return undefined
    let fee: number = EVE_POOL_FEE
    try {
      fee = Number(
        await client.readContract({
          address: sink,
          abi: EVE_BURN_ABI,
          functionName: 'evePoolFee',
        }),
      )
      if (!Number.isFinite(fee) || fee <= 0) fee = EVE_POOL_FEE
    } catch {
      /* use default 1% */
    }
    const quoted = (await client.readContract({
      address: ARC.UNI_QUOTER,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: ARC.USDC,
          tokenOut: EVE_TOKEN,
          amountIn: bal,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    const amountOut = quoted[0]
    if (!amountOut || amountOut <= 0n) return undefined
    const minOut = (amountOut * COOK_SLIP_BPS) / 10_000n
    if (minOut === 0n) return undefined
    const hash = await wallet.writeContract({
      address: sink,
      abi: EVE_BURN_ABI,
      functionName: 'cook',
      args: [bal, minOut],
      chain: wallet.chain,
    })
    await client.waitForTransactionReceipt({ hash, timeout: 90_000 })
    return hash
  } catch (e) {
    console.error('[blitz-bot] cook', e instanceof Error ? e.message : 'cook failed')
    return undefined
  }
}

async function claim(key: string, ttl: number): Promise<boolean> {
  try {
    const set = await kv.set(key, '1', { nx: true, ex: ttl })
    return set != null
  } catch {
    // Fail closed: never mint if we cannot lock the tweet/author.
    return false
  }
}

async function seen(key: string): Promise<boolean> {
  try {
    return Boolean(await kv.get(key))
  } catch {
    // Fail closed: treat as already handled.
    return true
  }
}

async function release(key: string): Promise<void> {
  try {
    await kv.del(key)
  } catch {
    /* ignore */
  }
}

async function mark(key: string, value: string, ttl: number): Promise<void> {
  try {
    await kv.set(key, value, { ex: ttl })
  } catch {
    /* ignore */
  }
}

async function replyTo(tweetId: string, text: string): Promise<void> {
  await xFetch('POST', '/tweets', {}, { text, reply: { in_reply_to_tweet_id: tweetId } })
}

/** Standalone tweet when X blocks a thread reply (replying under someone else's post). */
async function postStatus(text: string): Promise<void> {
  await xFetch('POST', '/tweets', {}, { text })
}

async function announce(tweetId: string, handle: string, text: string): Promise<void> {
  try {
    await replyTo(tweetId, text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[blitz-bot] reply', tweetId, msg)
    const who = handle.replace(/^@/, '')
    const body = who ? `@${who}\n${text}` : text
    await postStatus(body)
  }
}

function deployedReply(name: string, symbol: string, token: Address, tx: Hex): string {
  return [
    'your token has been deployed on arc.',
    '',
    `token: ${name} (${symbol})`,
    'contract:',
    token,
    'tx:',
    tx,
    '',
    'creator LP fees buy and burn $EVE.',
    '',
    `trade: https://arcfun.co/token/${token}`,
  ].join('\n')
}

async function handleMention(
  tw: XTweet,
  user: XUser,
  mediaByKey: Map<string, XMedia>,
  tweetsById: Map<string, XTweet>,
  users: Map<string, XUser>,
  pk: Hex | null,
  allowMint: boolean,
): Promise<'launched' | 'prefill' | 'ignored'> {
  if (!user.id) return 'ignored'
  // Quote-reposts that tag Eve are new tweets she can reply in. Plain RTs are not.
  if (isRetweetRef(tw.referenced_tweets)) return 'ignored'
  const createdAt = tw.created_at ? Math.floor(new Date(tw.created_at).getTime() / 1000) : 0
  if (createdAt && Date.now() / 1000 - createdAt > MAX_AGE_SEC) return 'ignored'

  const parsed = parseBlitzLaunchCommand(tw.text || '')
  if (!parsed) return 'ignored'
  if (xAccountTooNew(user.created_at)) return 'ignored'
  if (xFollowersTooLow(user.public_metrics?.followers_count)) return 'ignored'

  // One Instant create per tick (receipt wait is ~90s; Vercel max is 300s).
  if (pk && !allowMint) return 'ignored'

  if (await seen(TWEET_KEY(tw.id))) return 'ignored'
  if (!(await claim(TWEET_KEY(tw.id), TWEET_TTL_SEC))) return 'ignored'

  const tweet = toBlitzTweet(tw, user, mediaByKey, tweetsById)
  attachSource(tweet, tw, tweetsById, users)
  if (!tweet.imageUrl) {
    const pid = parentTweetId(tw.referenced_tweets)
    if (pid) tweet.imageUrl = await fetchTweetPhoto(pid)
  }

  try {
    if (!pk) {
      const draft = draftFromTweet(tweet)
      draft.name = parsed.name
      draft.symbol = parsed.symbol
      const url = `${siteOrigin()}/create?${prefillQuery(draft)}`
      await announce(tw.id, user.username, url)
      return 'prefill'
    }

    if (await seen(AUTHOR_KEY(user.id))) return 'ignored'
    if (!(await claim(AUTHOR_KEY(user.id), AUTHOR_TTL_SEC))) return 'ignored'
    if (!(await takeDailyMintSlot())) {
      await release(AUTHOR_KEY(user.id))
      return 'ignored'
    }

    try {
      const minted = await mintOnArc({
        name: parsed.name,
        symbol: parsed.symbol,
        tweet,
        pk,
      })
      await mark(AUTHOR_KEY(user.id), minted.token, AUTHOR_TTL_SEC)
      try {
        await announce(tw.id, user.username, deployedReply(parsed.name, parsed.symbol, minted.token, minted.tx))
      } catch (e) {
        console.error('[blitz-bot] announce', tw.id, e instanceof Error ? e.message : 'announce failed')
      }
      return 'launched'
    } catch (e) {
      await release(AUTHOR_KEY(user.id))
      throw e
    }
  } catch (e) {
    await release(TWEET_KEY(tw.id))
    console.error('[blitz-bot] mention', tw.id, e instanceof Error ? e.message : 'failed')
    return 'ignored'
  }
}

export async function runBlitzBotTick(): Promise<TickResult> {
  const handle = botHandle()
  const key = env('X_API_KEY')
  const secret = env('X_API_SECRET')
  const token = env('X_ACCESS_TOKEN')
  const accessSecret = env('X_ACCESS_SECRET')
  if (!handle || !key || !secret || !token || !accessSecret) {
    const missing = !handle
      ? 'BLITZ_BOT_HANDLE'
      : 'X user tokens'
    return { ok: true, skipped: missing }
  }

  const botId = await resolveBotUserId(handle)
  const startTime = new Date(Date.now() - MAX_AGE_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const query: Record<string, string> = {
    max_results: '25',
    start_time: startTime,
    'tweet.fields': 'created_at,author_id,in_reply_to_user_id,text,referenced_tweets,attachments',
    expansions: 'author_id,in_reply_to_user_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
    'user.fields': 'username,name,profile_image_url,created_at,public_metrics',
    'media.fields': 'url,preview_image_url,type',
  }
  const body = (await xFetch('GET', `/users/${botId}/mentions`, query)) as {
    data?: XTweet[]
    includes?: { users?: XUser[]; media?: XMedia[]; tweets?: XTweet[] }
  }
  const tweets = [...(body.data || [])].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0
    const tb = b.created_at ? Date.parse(b.created_at) : 0
    return ta - tb
  })
  const users = new Map((body.includes?.users || []).map((u) => [u.id, u]))
  const mediaByKey = new Map((body.includes?.media || []).map((m) => [m.media_key, m]))
  const tweetsById = new Map((body.includes?.tweets || []).map((t) => [t.id, t]))
  const pk = blitzBotPrivateKey()

  let launched = 0
  let prefills = 0
  let ignored = 0
  for (const tw of tweets) {
    if (!tw?.id) {
      ignored++
      continue
    }
    if (tw.author_id && tw.author_id === botId) {
      ignored++
      continue
    }
    const user = (tw.author_id && users.get(tw.author_id)) || {
      id: tw.author_id || '',
      username: 'user',
      name: 'user',
    }
    const result = await handleMention(tw, user, mediaByKey, tweetsById, users, pk, launched === 0)
    if (result === 'launched') launched++
    else if (result === 'prefill') prefills++
    else ignored++
  }

  let cooked: string | undefined
  if (pk) cooked = await cookEveBurn(pk)

  return { ok: true, scanned: tweets.length, launched, prefills, ignored, cooked }
}
