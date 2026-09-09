# ArcNS

The `.arc` name service for [arcfun](https://arcfun.co), on Arc (5042). Not affiliated with the
third-party `.arc` registrars already running on testnet (arcname.services, arcnames.xyz, etc.) —
this is arcfun's own.

- `ArcNS` — ERC-721 registrar. tokenId = `uint256(keccak256(label))`. Commit-reveal registration
  (ENS-shaped: `commit()` then `register()` ≥60s later, commitment expires after 24h) so a visible
  mempool tx can't be front-run. Per-length USDC/year pricing (owner-tunable table, defaults
  $50/$20/$10/$5/$2 for 3/4/5/6/7+ chars). 30-day grace period after expiry before a lapsed name
  is up for grabs again. Labels are lowercase `[a-z0-9-]`, 3-63 chars, no leading/trailing hyphen —
  rejecting case/non-ASCII variants up front closes the homoglyph-squatting hole the third-party
  registrars don't guard against.
- `ArcNSResolver` — forward (`label -> address`) and reverse (`address -> primary label`)
  resolution, plus free-form text records (`twitter`, `avatar`, ...). Every write re-checks live
  `ArcNS.ownerOf()` — no separate authorization state to go stale when a name changes hands.

No subdomain tree, no pluggable per-name resolver registry — this is a flat `<label>.arc`
namespace, not a full ENS port. Graduate to that later if arcfun ever needs subdomains.

**Fee split**: registration/renewal USDC splits 70/30 (owner-tunable via `setSplit`, must sum to
10000 bps) — not through CrucibleLock's `quoteSplit()` (that's shaped around paying a launched
token's creator, which doesn't exist here). The burn leg is a plain transfer to the same Crucible
burn sink address CrucibleLock's own `crucible` fee leg already pays into
(`0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6` on mainnet) — it just sits there as USDC until
`cook()` sweeps the sink's balance into an EVE buyback-and-burn (`npm run cook-crucible` from the
repo root, or whatever ends up running that on a schedule). No new burn mechanism needed. The
platform leg goes to `treasury`.

```bash
forge test -vv
```

Deploy:

```bash
# testnet (5042002) — no real burn sink there, so CRUCIBLE_SINK defaults to treasury
PRIVATE_KEY=0x... forge script script/DeployArcNSTestnet.s.sol --rpc-url $ARC_TESTNET_RPC --broadcast

# mainnet (5042) — CRUCIBLE_SINK defaults to the real sink above
PRIVATE_KEY=0x... forge script script/DeployArcNSMainnet.s.sol --rpc-url $ARC_RPC --broadcast
```

Not deployed anywhere yet. Ship testnet first, watch it for a bit, then mainnet.

Still open, not built here: a `/names` registrar page in the main app, an indexer that turns
`NameRegistered`/reverse-record events into a lookup cache (same shape as the candle-history
Supabase setup), and wiring `ArcNSResolver.nameOf()` into the places eve.fun already shows a raw
wallet address (trade tape, leaderboard, Crucible burn tape, profile pages).
