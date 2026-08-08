/**
 * coalescedFetch — collapse a burst of IDENTICAL concurrent GETs into a single network request.
 *
 * The rh4663 token page mounts ~15 independent data hooks, and each state update re-renders the tree;
 * children that fetch on mount/re-render end up hitting the same endpoint dozens of times in one load
 * (observed live: `/api/rh4663/[token]` ~34× per page load). On a CDN-warm token those are cache hits,
 * but on a COLD token they're a thundering herd against the rate-limited public RPC → 429s → the page
 * fails and the user has to reload repeatedly.
 *
 * This keys in-flight requests by URL: every caller that asks for the same URL while a request is still
 * in flight shares that one Promise, and each gets its own `.clone()` so it can read the body
 * independently. The entry clears the moment the request settles, so a later fetch (e.g. a post-trade
 * refresh, or the 30s poll) always starts fresh — no stale caching, just herd control.
 */
const inflight = new Map<string, Promise<Response>>()

export function coalescedFetch(url: string, init?: RequestInit): Promise<Response> {
  // Only coalesce plain GETs (the default). Anything with a body/method is passed straight through.
  if (init && init.method && init.method.toUpperCase() !== 'GET') return fetch(url, init)
  const existing = inflight.get(url)
  if (existing) return existing.then((r) => r.clone())
  const p = fetch(url, init)
  inflight.set(url, p)
  // Clear on settle (both fulfil and reject) so the next call re-fetches.
  p.then(() => inflight.delete(url), () => inflight.delete(url))
  return p.then((r) => r.clone())
}
