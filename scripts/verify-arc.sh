#!/usr/bin/env bash
# Verify ArcFun mainnet contracts on https://www.arcexplorer.org (custom API).
# Rate limit: 5 verify POSTs / hour / IP. Prefer `status` and local bytecode checks first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARC_INSTANT="$ROOT/contracts/arc-instant"
EXPLORER_API="${EXPLORER_API:-https://www.arcexplorer.org/api/v1}"
ARCSCAN_API="${ARCSCAN_API:-https://api.arc-scan.org/api}"
RPC="${ARC_RPC:-https://rpc.arc-scan.org}"
COMPILER="${COMPILER:-0.8.26+commit.8a97fa7a}"
UA="${UA:-Arcfun-verify/1.0}"

ADDRS=(
  "InstantLiveProxy|0x05BF9d713E1f58779aD4Dd8d6Fef4C7529c7323a"
  "InstantLiveImpl|0x2a0a428807ef78768d0db23b3607a09707a9077d"
  "InstantPrevProxy|0xd51E6217bb3bC7586866713854Ea75B7BefF1009"
  "InstantPrevImpl|0x8a930E86Fb0A33cAC80fB4a73d20400BA48a0cC7"
  "MonLockProxy|0x84F486d7254aEDc89986bce392771D88bf5828EA"
  "MonLockImpl|0x701ba347bbd231e604fbc4303d5a2dce8abe52ed"
  "ArcBpsSource|0xFCF6Bf9A66AA167BfE4F6165bb04baEd97B6C2aE"
  "EveBurn|0x292C8Fd478eC224aAC5CAf338c4d3B67203e899E"
  "CrucibleLock|0xE522907807CdDF006b433a103356d2c30ac39209"
  "InstantLockerAdapter|0x9deBd8d2CFa7dA789257146D325Af4094B1c1c5f"
  "Crucible|0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6"
  "ReferralRegistry|0x1E61c1DBcD0E2147Ae2247285B6788dAa4564033"
  "RobinOtcLiquidity|0xBD06241e272d05449A034abc0cfd558905c4aE3e"
)

json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1],""))' "$1"; }

status_one() {
  local name="$1" addr="$2"
  local ax arcscan code_len
  ax=$(curl -sS -H "User-Agent: $UA" "$EXPLORER_API/contracts/$addr" || echo '{}')
  arcscan=$(curl -sS -H "User-Agent: $UA" \
    "$ARCSCAN_API?module=contract&action=getsourcecode&address=$addr&apikey=empty" || echo '{}')
  code_len=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null | python3 -c 'import sys; c=sys.stdin.read().strip(); print((len(c)-2)//2 if c.startswith("0x") else 0)')
  local verified name_ax
  verified=$(printf '%s' "$ax" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("verified"))')
  name_ax=$(printf '%s' "$ax" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("contractName") or "")')
  local arc_name
  arc_name=$(printf '%s' "$arcscan" | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[{}])[0]; print(r.get("ContractName") or "")')
  printf '%-22s %s  code=%s  arcexplorer.verified=%s name=%s  arcscan.ContractName=%s\n' \
    "$name" "$addr" "$code_len" "$verified" "${name_ax:-}" "${arc_name:-}"
  echo "  ui https://www.arcexplorer.org/contract/$addr"
}

cmd_status() {
  for row in "${ADDRS[@]}"; do
    IFS='|' read -r name addr <<<"$row"
    status_one "$name" "$addr"
  done
}

post_verify() {
  local payload_file="$1"
  local code body
  code=$(curl -sS -o /tmp/verify-arc-resp.json -w '%{http_code}' \
    -H "User-Agent: $UA" -H 'content-type: application/json' -H 'accept: application/json' \
    -d @"$payload_file" "$EXPLORER_API/contracts/verify")
  body=$(cat /tmp/verify-arc-resp.json)
  echo "HTTP $code"
  echo "$body" | head -c 2000; echo
  if [[ "$code" == "429" ]]; then
    echo "Rate limited (5/hr on verify). Wait for Retry-After and retry." >&2
    return 29
  fi
  [[ "$code" == "200" ]]
}

cmd_submit_eve() {
  local src="$ROOT/contracts/eve-burn/src/EveBurn.sol"
  local ctor
  ctor=$(cast abi-encode 'constructor(address,address,address,uint24)' \
    0x3600000000000000000000000000000000000000 \
    0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77 \
    0x19209E55049bc613c5cC8b66B7DF7824096e78CF \
    10000)
  python3 - "$src" "$ctor" <<'PY' > /tmp/verify-eve.json
import json,sys
src=open(sys.argv[1]).read(); ctor=sys.argv[2]
payload={
  "address":"0x292C8Fd478eC224aAC5CAf338c4d3B67203e899E",
  "compilerVersion":"0.8.26+commit.8a97fa7a",
  "contractPath":"EveBurn.sol",
  "contractName":"EveBurn",
  "sources":{"EveBurn.sol":{"content":src}},
  "settings":{"optimizer":{"enabled":True,"runs":200},"evmVersion":"cancun","viaIR":False},
  # arcexplorer UI does not send these; included in case the worker accepts them
  "constructorArguments": ctor[2:] if ctor.startswith("0x") else ctor,
}
json.dump(payload, sys.stdout)
PY
  echo "Submitting EveBurn (exact local match: viaIR=false, opt=200, cancun)…"
  post_verify /tmp/verify-eve.json
  status_one EveBurn 0x292C8Fd478eC224aAC5CAf338c4d3B67203e899E
}

cmd_submit_crucible() {
  cd "$ARC_INSTANT"
  # Emit standard-json with cancun/viaIR/200 (body-matches on-chain; CID may still differ)
  local bak
  bak=$(mktemp)
  cp foundry.toml "$bak"
  cat > foundry.toml <<'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
solc = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
via_ir = true
bytecode_hash = "ipfs"
fs_permissions = [{ access = "read", path = "./script/bytecode"}]
remappings = [
    "forge-std/=lib/forge-std/src/",
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "v4-core/=lib/v4-core/",
]
TOML
  forge build --quiet
  forge verify-contract --show-standard-json-input \
    0xE522907807CdDF006b433a103356d2c30ac39209 \
    script/vendor-crucible/src/CrucibleLock.sol:CrucibleLock \
    > /tmp/cruciblelock.standard.json
  cp "$bak" foundry.toml
  python3 <<'PY' > /tmp/verify-cruciblelock.json
import json
data=json.load(open("/tmp/cruciblelock.standard.json"))
payload={
  "address":"0xE522907807CdDF006b433a103356d2c30ac39209",
  "compilerVersion":"0.8.26+commit.8a97fa7a",
  "contractPath":"script/vendor-crucible/src/CrucibleLock.sol",
  "contractName":"CrucibleLock",
  "sources":{k:{"content":v["content"]} for k,v in data["sources"].items()},
  "settings":{
    "optimizer":data["settings"]["optimizer"],
    "evmVersion":data["settings"].get("evmVersion","cancun"),
    "viaIR":data["settings"].get("viaIR", True),
    "metadata":data["settings"].get("metadata", {"bytecodeHash":"ipfs"}),
    "remappings":data["settings"].get("remappings", []),
  },
}
json.dump(payload, open("/tmp/verify-cruciblelock.json","w"))
print("sources", len(payload["sources"]))
PY
  echo "Submitting CrucibleLock multi-file…"
  post_verify /tmp/verify-cruciblelock.json
  status_one CrucibleLock 0xE522907807CdDF006b433a103356d2c30ac39209
}

cmd_impl_slots() {
  local slot=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
  for row in "${ADDRS[@]}"; do
    IFS='|' read -r name addr <<<"$row"
    local impl
    impl=$(cast storage "$addr" "$slot" --rpc-url "$RPC" 2>/dev/null || true)
    printf '%-22s %s  eip1967=%s\n' "$name" "$addr" "$impl"
  done
}

usage() {
  cat <<USAGE
Usage: $0 <status|impl-slots|submit-eve|submit-crucible>
  status          Check arcexplorer + arcscan getsourcecode for inventory
  impl-slots      Print EIP-1967 implementation slots
  submit-eve      POST EveBurn to arcexplorer (counts against 5/hr)
  submit-crucible POST CrucibleLock multi-file (counts against 5/hr)
USAGE
}

main() {
  local cmd="${1:-status}"
  case "$cmd" in
    status) cmd_status ;;
    impl-slots) cmd_impl_slots ;;
    submit-eve) cmd_submit_eve ;;
    submit-crucible) cmd_submit_crucible ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}
main "$@"
