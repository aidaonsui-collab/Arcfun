# ArcPort NFT launchpad

Phase 1 contracts for [arcfun](https://arcfun.co) NFT collections on Arc (5042).

- `ArcNftCollectionFactory` — UUPS factory. Same creation-fee waiver as Instant (`owner` free, else 0.1 native USDC → treasury). Clones `ArcNft721`. Optional `originToken` binds a collection to an Instant/Reflection launch; only that token's creator can set the link, one collection per token.
- `ArcNft721` — ERC-721 + EIP-2981. Fixed-price USDC (6dp) mint, 95% creator / 5% platform, per-wallet cap, merkle allowlist, reveal. Stores `originToken` when linked.

No marketplace contracts. Secondary is Seaport 1.6 later (Phase 2).

```bash
forge test -vv
```

Live on Arc mainnet (5042), owner `0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9`:

- factory proxy `0x0b7aD72020BDF5efECac11890DA8646f1339307e`
- factory impl `0xA73D46eC16C6CFF6676C0621Da313c0eCB77dBa9`
- NFT impl `0x6b3C0CAf98C42a29E0d628732ACA843799ac8594`

App reads `ARC.NFT_FACTORY` (`NEXT_PUBLIC_ARCPORT_FACTORY` override). Secondary marketplace is Seaport 1.6 later.

Owner can drop a collection from ArcPort without deleting the 721:

```bash
cast send $ARCPORT_FACTORY "setHidden(address,bool)" $COLLECTION true --rpc-url $ARC_RPC --private-key $ARCPORT_OWNER_KEY
```

Hiding also frees `originToken` so a later official collection can link.
