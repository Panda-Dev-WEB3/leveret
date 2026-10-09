#!/usr/bin/env bash
# Deploy (or upgrade) test-cluster builds to devnet, upgrade authority = the
# deployer key. Build first with `scripts/wsl-build.sh devnet`.
#   scripts/deploy-devnet.sh lvrt_oracle lvrt_engine ...
set -euo pipefail
source "$HOME/lvrt-env.sh" 2>/dev/null || true
REPO="$(cd "$(dirname "$0")/.." && pwd)"
KEYS="$REPO/keys"
DEPLOYER="${LVRT_DEPLOYER:-$KEYS/devnet-deployer.json}"
URL="${LVRT_RPC_URL:-https://api.devnet.solana.com}"
[ $# -gt 0 ] || { echo "usage: $0 <program>..." >&2; exit 2; }

echo "deployer $(solana-keygen pubkey "$DEPLOYER") balance $(solana balance "$(solana-keygen pubkey "$DEPLOYER")" --url "$URL")"
for p in "$@"; do
  so="$REPO/target/deploy-devnet/$p.so"
  need=$(solana rent "$(stat -c %s "$so")" --url "$URL" | awk '/Rent-exempt/{print $(NF-1)}')
  echo "== $p ($(stat -c %s "$so") bytes, ~$need SOL rent; the write buffer is folded into the program account)"
  solana program deploy --url "$URL" \
    --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
    --program-id "$KEYS/$p-keypair.json" "$so" \
    --max-sign-attempts 60
done
echo "balance after $(solana balance "$(solana-keygen pubkey "$DEPLOYER")" --url "$URL")"
