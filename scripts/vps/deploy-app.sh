#!/usr/bin/env bash
# Update the dev oracle's code from ~/leveret-upload/app.tgz (web/dev, web/src,
# package files) and restart it. Keys and node_modules are left alone; deps are
# reinstalled only when the lockfile changed. Run on the VPS.
set -euo pipefail
UP="$HOME/leveret-upload"
APP=/opt/leveret/app
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -C "$STAGE" -xzf "$UP/app.tgz"
relock=0
sudo cmp -s "$STAGE/web/package-lock.json" "$APP/web/package-lock.json" || relock=1
sudo rsync -a --delete --exclude node_modules "$STAGE/web/" "$APP/web/"
sudo chown -R leveret:leveret "$APP/web"
if [ "$relock" = 1 ]; then
  (cd "$APP/web" && sudo -u leveret env HOME=/tmp npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
fi
sudo systemctl restart leveret-oracle
rm -f "$UP/app.tgz"
echo "app updated (deps reinstalled: $relock)"
