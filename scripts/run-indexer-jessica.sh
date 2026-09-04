#!/bin/zsh
# Always-on Arc indexer + OTC book/keeper on Jessica (home Mac Air).
# Pull production env first:  vercel env pull --environment production .env.local
# Then:  caffeinate -dims ./scripts/run-indexer-jessica.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env.local ]]; then
  echo "missing .env.local — run: vercel env pull --environment production .env.local" >&2
  exit 1
fi
export INDEXER_WORKER="${INDEXER_WORKER:-jessica:$(scutil --get LocalHostName 2>/dev/null || hostname)}"
exec node --env-file=.env.local --experimental-strip-types --import ./scripts/alias-register.mjs lib/arc-indexer/daemon.ts
