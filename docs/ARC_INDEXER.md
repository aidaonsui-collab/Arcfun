# Arc event indexer

Background worker that keeps launch, trade-volume, and OTC offer state warm in Vercel KV so the UI does not re-scan the whole chain on every visit.

## What it indexes

| Source | Events / data | Used by |
|---|---|---|
| Instant factory | `InstantQuoteTokenCreated` + `allTokens` seed | Token discovery |
| Reflection factory | `InstantReflectionCreated` + `allTokens` seed | Token discovery |
| Uni V3 pools | Swap catch-up via existing `fetchArcTrades` KV tape | Volume 1H/6H/12H/24H, charts |
| OTC liquidity | `OfferCreated` + live `offers()` refresh | `/otc` book |

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /api/arc/indexer/run` | `Authorization: Bearer $CRON_SECRET` | Advance index (cron) |
| `GET /api/arc/indexer/status` | public | Health / cursors |
| `GET /api/otc/offers` | public | Indexed OTC book |

## Cron

`vercel.json` runs `/api/arc/indexer/run` every **2 minutes** (Pro plan required for 2‑min crons; otherwise change to `*/5`).

Requires project env:

- `CRON_SECRET` (Vercel injects Bearer automatically for crons)
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash)

OTC book (`/api/arc/indexer/otc`) and OTC settle (`/api/arc/keeper/otc`) are **not** Vercel crons. Jessica's Air runs both about every 60s inside `npm run indexer`. The HTTP routes stay as a manual trigger (`Authorization: Bearer $CRON_SECRET`).

## Dedicated loop (Jessica / home Mac Air)

The 2-minute factory/swap cron is a backup. OTC ticks live only on the Air. For sharc-style lag, run the same cycle in a tight loop on a machine that stays awake, writing the **production** KV.

On Jessica:

```bash
cd ~/code/arcfun   # or wherever the repo lives
git pull
vercel env pull --environment production .env.local
caffeinate -dims npm run indexer
```

Or `./scripts/run-indexer-jessica.sh` (also uses `caffeinate` if you wrap it).

The loop renews KV key `arcfun:idx:lease` every cycle. While that lease is live, the Vercel factory/swap cron returns `{ skipped: "dedicated-indexer" }` and does not race cursors. If the Air sleeps, the lease expires in ~45s and that cron takes over. OTC book and settle pause until the Air is awake again.

`/api/arc/indexer/status` reports `dedicated: true` and `lease.owner` when Jessica is writing.

Keep the lid open or use `caffeinate -dims`, and leave the Air plugged in. A laptop that sleeps is worse than the 2-minute cron.

## Manual run

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://<host>/api/arc/indexer/run" | jq .
```

## KV keys

- `arcfun:idx:state` — cursors + last run
- `arcfun:idx:tokens` — set of token addresses
- `arcfun:idx:token:{addr}` — token meta
- `arcfun:idx:vol:{addr}` — volume windows
- `arcfun:idx:otc:offers` / `arcfun:idx:otc:offer:{id}` — OTC book

Trade tapes stay under existing `arcfun:trades:*` keys (shared with token pages).

## Fallback behaviour

- Catalog still builds from factories if index is cold; volume fields stay 0 until indexer runs.
- OTC UI prefers `/api/otc/offers`, then falls back to client `getLogs` scan.
