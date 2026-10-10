#!/usr/bin/env bash
# Install / update Leveret on the VPS from ~/leveret-upload (site, app, keys).
set -euo pipefail
UP="$HOME/leveret-upload"
ROOT=/opt/leveret
REL="$ROOT/releases/$(date -u +%Y%m%d%H%M%S)"

id leveret >/dev/null 2>&1 || sudo useradd --system --home-dir "$ROOT" --no-create-home --shell /usr/sbin/nologin leveret
sudo mkdir -p "$ROOT/releases" "$ROOT/app" "$ROOT/app/keys"

# static site: new release, then switch the symlink
sudo mkdir -p "$REL"
sudo tar -C "$REL" -xzf "$UP/site.tgz"
sudo chown -R root:root "$REL"
sudo find "$REL" -type d -exec chmod 755 {} + && sudo find "$REL" -type f -exec chmod 644 {} +
sudo ln -sfn "$REL" "$ROOT/current"
# keep the last three releases
ls -1d "$ROOT"/releases/* | sort | head -n -3 | xargs -r sudo rm -rf

# dev oracle app (web/dev + web/src + production deps)
sudo rm -rf "$ROOT/app/web"
sudo tar -C "$ROOT/app" -xzf "$UP/app.tgz"
sudo tar -C "$ROOT/app" -xzf "$UP/keys.tgz"
sudo chown -R leveret:leveret "$ROOT/app"
# (no shell glob: the deploy user can't list the keys directory once it is 700)
sudo chmod 700 "$ROOT/app/keys" && sudo find "$ROOT/app/keys" -type f -name '*.json' -exec chmod 600 {} +
cd "$ROOT/app/web"
sudo -u leveret env HOME=/tmp npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

sudo tee /etc/systemd/system/leveret-oracle.service >/dev/null <<'UNIT'
[Unit]
Description=Leveret dev oracle (devnet): signed quotes, test-USDC faucet, keepers
After=network-online.target
Wants=network-online.target

[Service]
User=leveret
Group=leveret
WorkingDirectory=/opt/leveret/app
Environment=LVRT_CLUSTER=devnet
Environment=LVRT_ORACLE_PORT=8787
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON web/dev/oracle.ts
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/opt/leveret/app
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=1G

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable leveret-oracle >/dev/null 2>&1
sudo systemctl restart leveret-oracle
rm -f "$UP"/*.tgz
echo "installed $REL"
