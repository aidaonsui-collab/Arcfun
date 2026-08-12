# arcfun-otc (Goldsky)

Indexes Arc Instant OTC liquidity at `0xBD0624…4aE3e` (OfferCreated book, reserves, deliveries).

## Status (2026-08)

**Blocked on Goldsky network support.** Official Arc chain docs list:

- Subgraphs: **testnet only** (`arc-testnet`) — **mainnet not enabled**
- Deploy with `network: arc` / `arc-mainnet` fails:  
  `Subgraph network not supported: no network arc found on chain ethereum`

Until Goldsky enables Arc mainnet (chain id `5042`) for subgraphs, ArcFun serves the OTC book from the **KV arc-indexer** path (`GET /api/otc/offers` falls back automatically when `GOLDSKY_OTC_URL` is unset).

Ask Goldsky: [sales@goldsky.com](mailto:sales@goldsky.com?subject=Arc%20mainnet%20subgraph%20support) (or Arc partner form if sponsored).

## Deploy (once mainnet slug exists)

```bash
# Free Starter = 3 always-on subgraphs. Free a slot if needed:
#   goldsky subgraph pause <name>/1.0.0
#   goldsky subgraph delete <name>/1.0.0

cd subgraph/arcfun-otc
# Set network: in subgraph.yaml to the Goldsky slug they give you (e.g. arc or arc-mainnet)
npm install
npm run codegen
npm run build
goldsky subgraph deploy arcfun-otc/1.0.0 --path . --tag live
```

Copy the GraphQL API URL into ArcFun:

```bash
# Vercel / .env
GOLDSKY_OTC_URL=https://api.goldsky.com/api/public/project_…/subgraphs/arcfun-otc/1.0.0/gn
```

## Query (active offers)

```graphql
{
  otcOffers(where: { active: true, remaining_gt: "0" }, orderBy: premiumBps, orderDirection: asc) {
    id
    maker
    sellerPayment
    premiumBps
    remaining
    amount
    active
  }
}
```
