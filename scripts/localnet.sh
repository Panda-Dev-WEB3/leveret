#!/usr/bin/env bash
# Local validator with every Leveret program deployed upgradeable (upgrade
# authority = the deployer key), from the test-cluster build:
#   scripts/wsl-build.sh devnet && scripts/localnet.sh
# RPC http://127.0.0.1:8899, websocket ws://127.0.0.1:8900.
set -euo pipefail
source "$HOME/lvrt-env.sh" 2>/dev/null || true
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SO="$REPO/target/deploy-devnet"
KEYS="$REPO/keys"
DEPLOYER="${LVRT_DEPLOYER:-$KEYS/devnet-deployer.json}"
AUTH="$(solana-keygen pubkey "$DEPLOYER")"

args=()
for kp in "$KEYS"/lvrt_*-keypair.json; do
  name="$(basename "$kp" -keypair.json)"
  args+=(--upgradeable-program "$(solana-keygen pubkey "$kp")" "$SO/$name.so" "$AUTH")
done

exec solana-test-validator --reset --quiet --ledger "${LVRT_LEDGER:-$HOME/lvrt-ledger}" \
  --rpc-port 8899 \
  --mint "$AUTH" \
  "${args[@]}"
