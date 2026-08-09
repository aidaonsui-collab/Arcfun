#!/usr/bin/env bash
# Wire Instant Reflection addresses into Vercel and redeploy ArcFun.
set -euo pipefail
export PATH="/usr/bin:/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."

REF_FACTORY=0xEdf061e755b6dbb909b859Bc153719BeE0972fBB
REF_LOCKER=0xBcEf511D2CFe35b0913457dD52C532B0F3a712eE
INSTANT_FACTORY=0xd51E6217bb3bC7586866713854Ea75B7BefF1009
INSTANT_LOCKER=0x84F486d7254aEDc89986bce392771D88bf5828EA

for pair in \
  "NEXT_PUBLIC_ARC_REFLECTION_FACTORY=$REF_FACTORY" \
  "NEXT_PUBLIC_ARC_REFLECTION_LOCKER=$REF_LOCKER" \
  "NEXT_PUBLIC_ARC_INSTANT_FACTORY=$INSTANT_FACTORY" \
  "NEXT_PUBLIC_ARC_INSTANT_LOCKER=$INSTANT_LOCKER"
do
  key="${pair%%=*}"
  val="${pair#*=}"
  echo "Setting $key ..."
  printf '%s' "$val" | vercel env add "$key" production --force
  printf '%s' "$val" | vercel env add "$key" preview --force
done

echo "Deploying production..."
vercel --prod --yes
echo "Done → https://arcfun.vercel.app"
