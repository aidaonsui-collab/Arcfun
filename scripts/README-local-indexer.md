# Local indexer — sketch

Answers the question "can the indexer live on a home Mac to cut cost" with a working prototype,
not just an architecture pitch. **Not merged for a reason** — this is here to run and evaluate,
not to ship yet.

## What it is

[`local-indexer.ts`](./local-indexer.ts) proactively catches every active token's trade cursor up
to chain head, on a timer, by calling the exact same [`syncTradesToHead`](../lib/arc-trades.ts)
that `/api/arc/[token]/trades` already calls on demand. Same function, same coalescing, same KV
keys, same cursor — this just triggers it on a schedule instead of waiting for a page view.

## Why it's safe to point at a home machine

Both connections it makes are **outbound only** — to the Arc RPC, and to Vercel KV's REST API.
Nothing needs to reach *in*, so there's no port-forwarding, no CGNAT problem, no home network
exposed to the internet.

And it's additive, not load-bearing: the on-demand path this process shares code with is
untouched. If this process is asleep, offline, crashed, or never started, every token page keeps
working exactly as it does today — just without the head start. It can only make things fresher
when it's up; it's never a new single point of failure.

## Try it

```bash
npx tsx --env-file=.env.local scripts/local-indexer.ts --once
```

Runs one pass across every active token and exits — the fastest way to see it work and read its
output before deciding whether to leave it running. Uses the same `KV_REST_API_URL` /
`KV_REST_API_TOKEN` / `ARC_RPC` your `.env.local` already has for the Next.js app itself.

To loop continuously instead: drop `--once`. `--interval=N` sets the seconds between passes
(default 10).

## Before leaving it running unattended

- **Keep the Mac from sleeping** — `caffeinate -i`, or `pmset` while it's meant to stay up. A
  sleeping Mac just stops writing; safe, but silently stale.
- **Supervise it** so it survives a crash or reboot —
  [`local-indexer.launchd.plist.example`](./local-indexer.launchd.plist.example) is a template,
  not installed by anything here. Fill in the two absolute paths and `launchctl load` it yourself
  when you're ready; I'm not loading a LaunchAgent on your machine as part of a sketch.
- **Some form of alerting** if you want to actually notice extended downtime — today the only
  signal is this process's own stdout / the launchd log files.

## What this deliberately doesn't cover

Scoped to the trade tape only, matching what was actually slow — it does not proactively warm
`/api/arc/[token]`'s pool-info/liquidity/burn-% route, which has its own separate cold-RPC cost.
Same shape of fix would apply there if it's ever worth doing; not built here to keep this sketch
to what was asked.
