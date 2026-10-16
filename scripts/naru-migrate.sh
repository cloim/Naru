#!/bin/sh
# Copies a stopped Docker data-root (e.g. External Engine /var/lib/docker bound at $1) into Naru.
# Run inside the naru distribution as root while both engines are stopped.
set -eu
src="${1:-/mnt/wsl/naru-migrate/source}"
dst=/var/lib/naru/docker
partial="$dst.partial"
log=/var/log/naru/migrate.log
mkdir -p /var/log/naru
exec >> "$log" 2>&1
echo "== $(date -Iseconds) migrate from $src"
[ -d "$src/containers" ] && [ -d "$src/image" ] || { echo 'source is not a Docker data-root'; exit 2; }
if [ -f /run/naru/supervisor.pid ] && kill -0 "$(cat /run/naru/supervisor.pid)" 2>/dev/null; then
  echo 'Naru engine is running; stop it first'
  exit 3
fi
rm -rf "$partial"
mkdir -p "$partial"
chmod 710 "$partial"
# Overlay snapshots need trusted.* xattrs, whiteout devices, hard links and numeric owners intact.
(cd "$src" && tar --xattrs --xattrs-include='*' --sparse --numeric-owner -cpf - .) |
  (cd "$partial" && tar --xattrs --xattrs-include='*' --numeric-owner -xpf -)
# Container configs keep absolute paths of logs, hosts files and volume sources.
find "$partial/containers" -maxdepth 2 \( -name config.v2.json -o -name hostconfig.json \) \
  -exec sed -i 's#"/var/lib/docker/#"/var/lib/naru/docker/#g' {} +
if [ -d "$dst" ]; then mv "$dst" "$dst.pre-migration-$(date +%Y%m%d%H%M%S)"; fi
mv "$partial" "$dst"
du -s "$src" "$dst"
echo "== $(date -Iseconds) done"
