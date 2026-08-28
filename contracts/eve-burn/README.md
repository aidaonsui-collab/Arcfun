# EveBurn

Sink for Instant-creator USDC on `@watch_eve` Blitz launches. Cooks USDC → `$EVE` → `0xdead`.
The mention bot never stamps a tweet `0x` as creatorRewardsWallet.

`$EVE` `0x19209E55049bc613c5cC8b66B7DF7824096e78CF` (18dp). Uni V3 USDC pool fee **10000**.

MonLock just transfers USDC here. A keeper must call `cook(amountIn, minOut)`.

## Deploy (Arc 5042)

```text
usdc         0x3600000000000000000000000000000000000000
swapRouter   0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77
eve          0x19209E55049bc613c5cC8b66B7DF7824096e78CF
evePoolFee   10000
```

Then in Vercel:

- `BLITZ_EVE_BURN` / `NEXT_PUBLIC_EVE_BURN` = this contract
- `setKeeper` the Blitz bot wallet so the minute cron can cook
