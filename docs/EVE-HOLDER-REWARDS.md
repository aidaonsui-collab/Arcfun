# $EVE holder rewards — 2-week experiment (drafted 2026-09-04)

## What this is

$EVE's locked LP position (MonLock tokenId `4695`) splits every USDC fee collection **70%
creator / 30% platform beneficiary**. The creator's 70% is immutable — MonLock stamps
`creatorSplits[tokenId]` once at lock time with no setter afterward. The platform's own 30% is the
only leg we can move, and only via `setLockBeneficiary`, callable exclusively by the *current*
beneficiary.

This is a **proposed** 2-week experiment. It does **not** start on merge, and it is **not** live
until the platform owner finishes the one-time setup below (beneficiary still points at the
treasury until then). Once armed, the platform's 30% leg is redirected from the treasury to a
dedicated keeper wallet that collects it, swaps it into **$COOL**
(`0xeb64987643db71c76b2a2be7e723decc995e5b37`), and pro-rata disperses it to every current EVE
holder about once an hour. After 14 days — counted from the first successful keeper tick that
stamps KV state — the keeper automatically hands the beneficiary back to the treasury and stops.
See [lib/arc-eve-holder-rewards.ts](../lib/arc-eve-holder-rewards.ts) for the exact mechanics.

This does **not** touch the creator's 70% — that's contractually impossible from our side (see
that file's header comment and `lib/arc-creator-fees.ts`).

## Keeper wallet

```
Address:     0x17A0f26daE40AE5eF7b4357d53cDbaFd767Ce6f1
Private key: (given to the platform owner directly, not committed anywhere)
```

Generated fresh for this experiment only. Its only powers are: whatever `setLockBeneficiary`
grants on position 4695 (collect that leg, retarget the beneficiary again, and — only after
`unlockTime`, ~Aug 2027 — withdraw the LP NFT itself), and spending its own held USDC/COOL
balance.

**Key custody:** after the redirect in step 2, *only* this keeper can call `setLockBeneficiary`
on position 4695 again. A lost key strands the platform's 30% at this wallet until unlock
(~Aug 2027). Back the key up offline **before** step 2. The Vercel env var is a working copy —
not the only copy.

Fund it with a *small* amount of **native ARC** before the first cron tick (see step 1). On Arc,
native gas and the ERC-20 USDC balance share the same address and the same underlying USD value
(1:1 peg), but they are **not** interchangeable without a transfer: txs need native balance. The
keeper leaves ~$0.30 of ERC-20 USDC untouched each cycle as a reserve and self-funds gas after
the first collect.

## One-time manual setup (platform owner)

> **Do not merge or deploy this PR (and do not let a second timer (Vercel no longer schedules this route) fire) until
> steps 1–3 below are done.** The first cron tick that runs stamps `startedAt` / `expiresAt` in
> KV. If on-chain beneficiary is still the treasury (or anything other than the keeper), that
> tick treats the program as “externally reverted,” pays out nothing, and **marks it permanently
> ended**. Safe order: fund → redirect → set env → *then* merge/deploy → confirm status.

1. **Send starter gas.** From any wallet, send **~2 USDC-equivalent of native ARC** to
   `0x17A0f26daE40AE5eF7b4357d53cDbaFd767Ce6f1` (a plain native transfer, not a contract call).
   This only needs to cover the very first `collectFees` call — after that the keeper's own
   collected balance covers its own gas. ERC-20 USDC at the same address is not gas by itself.

2. **Redirect the beneficiary.** From `0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9` (the wallet
   that currently owns/beneficiaries position 4695 on MonLock), call:

   ```
   MonLock.setLockBeneficiary(4695, 0x17A0f26daE40AE5eF7b4357d53cDbaFd767Ce6f1)
   ```

   MonLock is at `0x84F486d7254aEDc89986bce392771D88bf5828EA`. Either:

   - **arcexplorer.org** → contract `0x84F4…828EA` → Write Contract tab → connect
     `0x26bD…413c9` → `setLockBeneficiary` → `tokenId = 4695`,
     `next = 0x17A0f26daE40AE5eF7b4357d53cDbaFd767Ce6f1` → send, **or**
   - `cast send`:
     ```bash
     cast send 0x84F486d7254aEDc89986bce392771D88bf5828EA \
       "setLockBeneficiary(uint256,address)" 4695 0x17A0f26daE40AE5eF7b4357d53cDbaFd767Ce6f1 \
       --private-key $TREASURY_PRIVATE_KEY \
       --rpc-url https://rpc.arc-scan.org
     ```

   **This is the point of no return for the manual side** — once sent, only the keeper wallet
   (not `0x26bD…413c9`) can call `setLockBeneficiary` on this position again. That's by design
   (see the safety net below for the manual override path). Confirm the key is backed up first.

3. **Set the Vercel env var.** Add `ARC_EVE_REWARDS_KEEPER_PRIVATE_KEY` (server-only, no
   `NEXT_PUBLIC_` prefix) in the Vercel project settings, value = the keeper's private key.
   Ensure `CRON_SECRET` is also set (Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on
   the mutating path). Deploy / merge **only after** steps 1–2.

4. **Confirm it's running.** After the next Air tick (hourly `com.eve.holder-rewards`), check:
   ```
   https://www.arcfun.co/api/arc/keeper/eve-holder-rewards?status=1
   ```
   `?status=1` is public and read-only (no secrets, no on-chain action). `state.startedAt` /
   `state.expiresAt` confirm the 14-day window; `recentCycles` shows each tick's
   collect/swap/disperse activity. The mutating cron endpoint itself requires the bearer secret
   above.

## Ending early / safety net

If anything looks wrong and you want to stop this before the 14 days are up, the keeper wallet
(not the treasury wallet) is the only one that can revert it now:

```bash
cast send 0x84F486d7254aEDc89986bce392771D88bf5828EA \
  "setLockBeneficiary(uint256,address)" 4695 0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9 \
  --private-key $ARC_EVE_REWARDS_KEEPER_PRIVATE_KEY \
  --rpc-url https://rpc.arc-scan.org
```

The next cron tick after this detects the beneficiary is no longer the keeper, pays out whatever
$COOL balance is left to holders in one final sweep, and marks the program ended — no further
action needed.

## What holders actually receive

Every ~15 minutes, when accrued fees clear the dust floors below: the keeper swaps collected USDC
into $COOL on its one live Uniswap V3 pool (1% fee tier,
`0x40732e01ba7A829DEA44f51a10e7C58cd9F37765`, ~$138k USDC-side reserves as of 2026-09-04) with a
5% slippage bound, then sends $COOL to every current EVE holder in proportion to their EVE
balance, via the already-deployed [ArcDisperse](../contracts/arc-nft/src/ArcDisperse.sol)
contract. Protocol addresses (factories, lockers, the dead address, the keeper itself, and the
EVE Uni V3 pool) are excluded, same idea as the Holders tab.

**Dust floors** (quiet ticks below these are expected, not a bug):

- Skip `collectFees` when the simulated claim is under **$0.05** USDC — let fees accrue another
  cycle instead of paying gas for dust.
- Skip swap + disperse when the keeper's distributable USDC (balance minus ~$0.30 gas reserve)
  is under **$5** — not worth a swap plus batch disperse txs. The final ending sweep ignores the
  $5 floor so leftover balance still pays out.
