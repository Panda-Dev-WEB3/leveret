#!/usr/bin/env bash
# Publish a new static-site release from ~/leveret-upload/site.tgz (the
# oracle app and keys are untouched). Run on the VPS.
set -euo pipefail
UP="$HOME/leveret-upload"
ROOT=/opt/leveret
REL="$ROOT/releases/$(date -u +%Y%m%d%H%M%S)"
sudo mkdir -p "$REL"
sudo tar -C "$REL" -xzf "$UP/site.tgz"
sudo chown -R root:root "$REL"
sudo find "$REL" -type d -exec chmod 755 {} + && sudo find "$REL" -type f -exec chmod 644 {} +
sudo ln -sfn "$REL" "$ROOT/current"
ls -1d "$ROOT"/releases/* | sort | head -n -3 | xargs -r sudo rm -rf
rm -f "$UP/site.tgz"
echo "published $REL"
