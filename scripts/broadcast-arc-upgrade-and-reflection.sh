#!/usr/bin/env bash
# Broadcast Instant factory upgrade + Instant Reflection deploy on Arc mainnet (5042).
# Usage (from repo root):
#   bash scripts/broadcast-arc-upgrade-and-reflection.sh
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
  if cast chain-id --rpc-url "$try" >/dev/null 2>&1; then
    RPC="$try"
    break
  fi
done

ADDR=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "Deployer: $ADDR"
echo "RPC:      $RPC"
echo "Chain:    $(cast chain-id --rpc-url "$RPC")"
echo "Balance:  $(cast balance "$ADDR" --rpc-url "$RPC")"
echo ""

cd "$CONTRACTS"

echo "=== 1/2 Upgrade Instant factory (createTokenMemeInstantQuoteTo) ==="
forge script script/UpgradeInstantUsdcArcCreatorRewards.s.sol:UpgradeInstantUsdcArcCreatorRewards \
  --rpc-url "$RPC" --broadcast --slow -vv

echo ""
echo "=== 2/2 Deploy Instant Reflection (upgradeable) ==="
forge script script/DeployInstantReflectionArc.s.sol:DeployInstantReflectionArc \
  --rpc-url "$RPC" --broadcast --slow -vv

echo ""
echo "=== Broadcast complete ==="
echo "Copy NEXT_PUBLIC_ARC_REFLECTION_FACTORY / NEXT_PUBLIC_ARC_REFLECTION_LOCKER from the logs"
echo "into arcfun .env.local / .env.deploy and Vercel, then redeploy."
