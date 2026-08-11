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
