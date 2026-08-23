# ArcPort NFT launchpad

Phase 1 contracts for [arcfun](https://arcfun.co) NFT collections on Arc (5042).

- `ArcNftCollectionFactory` — UUPS factory. Same creation-fee waiver as Instant (`owner` free, else 0.1 native USDC → treasury). Clones `ArcNft721`.
- `ArcNft721` — ERC-721 + EIP-2981. Fixed-price USDC (6dp) mint, 95% creator / 5% platform, per-wallet cap, merkle allowlist, reveal.

No marketplace contracts. Secondary is Seaport 1.6 later (Phase 2).

```bash
forge test -vv
```

Deploy:

```bash
ARCPORT_OWNER=0x… forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC --broadcast
```

Then set `NEXT_PUBLIC_ARCPORT_FACTORY` to the proxy address. Port reads `allCollections` from that factory. Secondary marketplace is Seaport 1.6 later.
