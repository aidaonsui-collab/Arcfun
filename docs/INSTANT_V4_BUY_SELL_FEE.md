# Instant V4: asymmetric buy / sell fee

**Status:** implemented in source. Already-launched pools stay on the previous hook. New launches pick up buy and sell fees only after a new EveFeeHook and both factories are deployed and create is pointed at them.  
**Date:** 2026-09-22  
**Decision locked:** max fee **5%** (`MAX_FEE_BPS = 500`) on each of buy and sell.  
**Scope:** eve.fun Instant V4 (`EveFeeHook` + factories + create UI + router quotes + indexer)  
**Out of scope:** Instant V3 (stays tax-free plain ERC-20), transfer-tax / honeypot tokens, Argus-style anti-snipe decay (separate later)

---

## Goal

Match Argus-shaped **separate buy vs sell fee** at create time, while keeping Instant’s current model:

- Plain `LaunchToken18` (no transfer tax)
- Fee taken in Uniswap v4 `afterSwap` via `EveFeeHook`
- Same destination split (creator / burn / holders / auto-LP / platform)
- Platform floor **10% of the fee** (`MIN_PLATFORM_BPS = 1000`)

Today Instant has **one** `feeBps` (0.3–3%), same on buys and sells. This change replaces that with `buyFeeBps` and `sellFeeBps`, and raises the per-side cap to **5%**.

---

## Product rules

| Rule | Value |
|------|--------|
| Buy fee range | **30–500 bps** (0.3–5%) |
| Sell fee range | **30–500 bps** (0.3–5%) |
| Equal fees allowed | Yes — set both to the same value (today’s behavior) |
| Immutable after create | Yes — stored in pool config at register; no setter |
| Split destinations | Unchanged: `creatorBps + burnBps + holdersBps + autoLpBps + platformBps == 10_000` |
| Platform floor | Unchanged: `platformBps >= 1000` |
| Token bytecode | Unchanged plain ERC-20 |
| Default create | `buyFeeBps = sellFeeBps = 100` (1%), same as current default |
| Label in Instant chrome | “fee / cut” — not “tax” |

**Not in v1:** decaying anti-snipe tax, per-wallet tax, transfer tax, buy≠sell *destination* splits (one split applies to both directions).

---

## Buy vs sell definition (on-chain)

Fee is still levied on the **unspecified currency** (what the swapper receives) — same as today in `EveFeeHook.afterSwap`.

That already encodes direction:

- **Buy** = swapper receives the launch token → `feeCurrency == launch` → use `buyFeeBps`
- **Sell** = swapper receives the quote → `feeCurrency != launch` → use `sellFeeBps`

```solidity
uint16 feeBps = (Currency.unwrap(feeCurrency) == c.launch) ? c.buyFeeBps : c.sellFeeBps;
uint256 feeAmount = (unspecifiedAbs * feeBps) / BPS_DENOM;
```

No `zeroForOne` / `tokenIsCurrency0` branching required for the rate itself.

---

## ABI / storage changes

### Constants

```solidity
uint16 public constant MIN_FEE_BPS = 30;   // 0.3%
uint16 public constant MAX_FEE_BPS = 500;  // 5%  (was 300)
uint16 public constant MIN_PLATFORM_BPS = 1_000; // 10% of fee
```

### `EveFeeHook.Split` (create calldata)

```solidity
struct Split {
    uint16 buyFeeBps;   // NEW — replaces feeBps
    uint16 sellFeeBps;  // NEW
    uint16 creatorBps;
    uint16 burnBps;
    uint16 holdersBps;
    uint16 autoLpBps;
    uint16 platformBps;
}
```

### Pool config

Replace `feeBps` with `buyFeeBps` + `sellFeeBps`. Validate each in `[MIN_FEE_BPS, MAX_FEE_BPS]`. Platform / sum checks unchanged.

### Events

- `PoolRegistered` / equivalent — embed updated `Split`
- Factory `TokenLaunched`: emit **both** fees (breaking for indexers that decode a single positional `feeBps`)

Suggested factory event shape:

```solidity
event TokenLaunched(
    address indexed token,
    address indexed quote,
    address indexed creator,
    PoolId id,
    bool tokenIsCurrency0,
    uint16 buyFeeBps,
    uint16 sellFeeBps
);
```

Legacy single-`feeBps` events stay historically true for already-deployed factories; **new** factory/hook deploys use the dual fields.

### Validation in `registerPool`

```solidity
if (split.buyFeeBps < MIN_FEE_BPS || split.buyFeeBps > MAX_FEE_BPS) revert BadFeeBps();
if (split.sellFeeBps < MIN_FEE_BPS || split.sellFeeBps > MAX_FEE_BPS) revert BadFeeBps();
// platform + sum checks unchanged
```

---

## Deploy strategy (money-moving — explicit yes required)

Live hook and factories are immutable for already-registered pools.

1. CREATE2-deploy new `EveFeeHook` with dual fees (new address; flags still `AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA`).
2. Deploy new Instant + RWA factories pointed at the new hook (or USDC Instant only first — rollout call below).
3. Point create UI / env at the new factory addresses.
4. Leave old factories + hook live for tokens already launched (same pattern as V3 → V4).
5. Redeploy router only if it hardcodes a single fee; otherwise update off-chain quote math.

No migration of existing pools. Asymmetric fees are **new creates only**.

---

## App / tooling surface

| Surface | Change |
|---------|--------|
| `lib/eve-fee-split.ts` | `FeeSplit`: `buyFeeBps` + `sellFeeBps`; `MAX_FEE_BPS = 500`; presets set both equal |
| `FeeSplitCard.tsx` | Two sliders (Buy / Sell), link toggle “Same on buys & sells” (default on); range 0.3–5% |
| Create / launchpad ABI helpers | Tuple + encoding for dual fees |
| Create quotes / first-buy | Use `buyFeeBps` |
| Swap quote UI | Buy path → `buyFeeBps`; sell path → `sellFeeBps` |
| Token page / badges | `Buy x% · Sell y%` when unequal; single `%` when equal |
| Indexer | Parse dual fields from new `TokenLaunched`; keep single-fee decode for old factories |
| RWA create | Same `Split`; holders rules unchanged |

### UX copy (create)

- Default: linked sliders at **1.0%** buy and sell.
- Unlink → independent Buy / Sell, each 0.3–5.0%.
- Helper: “Fee is taken from what the trader receives. Split below decides where it goes.”

---

## Tests (acceptance)

1. Create with `buy = sell = 100` → identical fee amounts to today’s 1% on buy and sell swaps.
2. Create with `buy = 30`, `sell = 500` → buy takes 0.3%, sell takes 5%; destinations still sum correctly.
3. Reject `buy` or `sell` outside 30–500; reject `platformBps < 1000`; reject split sum ≠ 10_000.
4. First-buy at create uses `buyFeeBps`.
5. Quote-side burn / auto-LP flush paths still work when sell fee accrues quote.
6. Old V4 pools on previous hook unchanged.
7. Router / UI quotes within slippage of on-chain fee for both directions.

---

## Effort sketch

| Workstream | Rough |
|------------|--------|
| Hook + factory Solidity + Foundry tests | 1–2 days |
| CREATE2 deploy + allowlist + env wiring | 0.5 day |
| FeeSplitCard + create + swap quotes | 1 day |
| Indexer / token page display | 0.5 day |
| Testnet dry-run + mainnet cutover | 0.5–1 day |

---

## Remaining ship calls

Locked from product: **max 5% per side**.

Ship yes is in. Both factories share the new `Split`, so the cutover deploys USDC and RWA together. The label stays fee.

Still needed before mainnet:

1. CREATE2-deploy the new hook, `setFactoryAllowed` on it, deploy both factories, point create env at the new addresses.
2. Leave the previous hook and factories in the catalog so existing tokens keep trading.
