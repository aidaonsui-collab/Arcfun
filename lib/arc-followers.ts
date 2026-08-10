/**
 * Creator follow graph on Vercel KV (Redis sets).
 */
import { kv } from '@vercel/kv'

const followersKey = (a: string) => `arcfun:followers:${a.toLowerCase()}`
const followingKey = (a: string) => `arcfun:following:${a.toLowerCase()}`

export async function getFollowCounts(address: string): Promise<{ followers: number; following: number }> {
  try {
    const [followers, following] = await Promise.all([
      kv.scard(followersKey(address)),
      kv.scard(followingKey(address)),
    ])
    return { followers: Number(followers) || 0, following: Number(following) || 0 }
  } catch {
    return { followers: 0, following: 0 }
  }
}

export async function isFollowing(follower: string, target: string): Promise<boolean> {
  try {
    return Boolean(await kv.sismember(followersKey(target), follower.toLowerCase()))
  } catch {
    return false
  }
}

export async function follow(follower: string, target: string): Promise<void> {
  const f = follower.toLowerCase()
  const t = target.toLowerCase()
  if (f === t) throw new Error('cannot follow yourself')
  await Promise.all([kv.sadd(followersKey(t), f), kv.sadd(followingKey(f), t)])
}

export async function unfollow(follower: string, target: string): Promise<void> {
  const f = follower.toLowerCase()
  const t = target.toLowerCase()
  await Promise.all([kv.srem(followersKey(t), f), kv.srem(followingKey(f), t)])
}
