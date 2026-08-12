# arcfun-otc (Goldsky)

Indexes Arc Instant OTC liquidity at `0xBD0624…4aE3e` (OfferCreated book, reserves, deliveries).

## Deploy

```bash
# Free Starter is limited to 3 always-on subgraphs. If deploy fails, free a slot:
#   goldsky subgraph pause robinpad-stable/1.0.0

cd subgraph/arcfun-otc
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
