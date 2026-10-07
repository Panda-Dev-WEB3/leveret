#!/usr/bin/env bash
# Build (and optionally test) the Leveret workspace inside WSL.
#
# Source of truth is the Windows checkout; it is mirrored to a native Linux
# directory because cargo on /mnt/* (9P) is several times slower. Artifacts
# (.so, IDL, keypairs) are copied back to <repo>/target/deploy and target/idl.
#
#   scripts/wsl-build.sh             # anchor build
#   scripts/wsl-build.sh test        # anchor build + cargo test (math + LiteSVM)
#   scripts/wsl-build.sh check       # cargo check only (fast)
set -euo pipefail

source "$HOME/lvrt-env.sh" 2>/dev/null || true
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${LVRT_BUILD_DIR:-$HOME/leveret-build}"
MODE="${1:-build}"

mkdir -p "$BUILD/target/deploy"
rsync -a --delete \
  --exclude target --exclude node_modules --exclude .anchor --exclude test-ledger --exclude keys \
  "$REPO/" "$BUILD/"

# Program keypairs live in <repo>/keys (git-ignored); restore them so program
# IDs stay stable across clean build dirs.
cp -n "$REPO"/keys/*-keypair.json "$BUILD/target/deploy/" 2>/dev/null || true

cd "$BUILD"
case "$MODE" in
  check)
    cargo check --workspace --all-targets
    ;;
  build|test)
    anchor build "${@:2}"
    mkdir -p "$REPO/target/deploy" "$REPO/target/idl"
    cp target/deploy/*.so "$REPO/target/deploy/"
    cp target/idl/*.json "$REPO/target/idl/" 2>/dev/null || true
    if [ "$MODE" = test ]; then
      cargo test -p lvrt_math --quiet
      cargo test -p lvrt_tests -- --test-threads=4
    fi
    ;;
  *)
    echo "usage: $0 [build|test|check]" >&2
    exit 2
    ;;
esac
