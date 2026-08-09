#!/usr/bin/env bash
# Deploy Instant Reflection USDC factory + ArcLock on Arc mainnet (5042).
# Replaces the WETH-paired InstantReflection stack for Arc product.
set -euo pipefail
export PATH="/usr/bin:/bin:/opt/homebrew/bin:$HOME/.foundry/bin:$PATH"

ARCFUN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$HOME/code/robots-merge/contracts/monad-launchpad}"

set -a
# shellcheck disable=SC1091
source "$ARCFUN_ROOT/.env.deploy"
set +a
: "${PRIVATE_KEY:?PRIVATE_KEY missing in .env.deploy}"

RPC="${ARC_RPC_URL:-https://arc-mainnet-rpc.baracat.meme}"
for try in "${ARC_RPC_URL:-}" "https://arc-mainnet-rpc.baracat.meme"; do
  [ -z "$try" ] && continue
  if cast chain-id --rpc-url "$try" >/dev/null 2>&1; then RPC="$try"; break; fi
done

echo "Deployer: $(cast wallet address --private-key "$PRIVATE_KEY")"
echo "RPC: $RPC  chain=$(cast chain-id --rpc-url "$RPC")"
echo ""

cd "$CONTRACTS"
echo "=== Deploy InstantReflectionUsdcFactory (TOKEN/USDC) ==="
forge script script/DeployInstantReflectionUsdcArc.s.sol:DeployInstantReflectionUsdcArc \
  --rpc-url "$RPC" --broadcast --slow -vv

echo ""
echo "Copy NEXT_PUBLIC_ARC_REFLECTION_FACTORY / LOCKER from logs into .env.local + Vercel."
SCRIPT
