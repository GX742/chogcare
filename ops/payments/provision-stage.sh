#!/bin/sh
# Generic reviewed staging ONLY. No state/credential transfer or signer start.
set -eu
[ "$#" = 3 ] && [ "$1" = --stage-only ] && [ "$(id -u)" = 0 ] || exit 1
archive=$2
archive_sha=$3
runtime=/opt/chogcare-node-v24.22.0
code=/opt/chogcare-payments
node_sha=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(uname -m)" = x86_64 ] || exit 1
for command in curl tar xz sha256sum python3 systemctl systemd-analyze systemd-creds useradd install setfacl fallocate mkswap swapon timeout; do
    command -v "$command" >/dev/null || { echo 'A staging prerequisite is missing.' >&2; exit 1; }
done
# Do not touch an existing installation, credential or private state file.
[ ! -e "$code" ] && [ ! -L "$code" ] && [ ! -e "$runtime" ] && [ ! -L "$runtime" ] || exit 1
for unit in chogcare-payments.service chogcare-station.service; do
    if systemctl is-active --quiet "$unit" || systemctl is-enabled --quiet "$unit"; then exit 1; fi
    [ ! -e "/etc/systemd/system/$unit" ] && [ ! -L "/etc/systemd/system/$unit" ] || exit 1
done
for directory in /var/lib/chogcare /var/lib/chogcare-station; do
    [ ! -L "$directory" ] || exit 1
    if [ -e "$directory" ]; then
        [ -d "$directory" ] || exit 1
        [ -z "$(find "$directory" -mindepth 1 ! -type d -printf x -quit)" ] || exit 1
    fi
done
stage=$(mktemp -d /opt/chogcare-stage-XXXXXXXX)
chmod 0700 "$stage"
python3 "$helper_dir/verify-code-package.py" --copy-safe "$archive" "$archive_sha" "$stage/code.tar.gz"
# The verified fixed archive has no links, special files or out-of-tree paths.
tar -xzf "$stage/code.tar.gz" --no-same-owner --no-same-permissions -C "$stage"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 --max-filesize 134217728 "https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz" -o "$stage/node.tar.xz"
printf '%s  %s\n' "$node_sha" "$stage/node.tar.xz" | sha256sum --check --status
tar -xJf "$stage/node.tar.xz" --no-same-owner --no-same-permissions -C "$stage"
[ "$("$stage/node-v24.22.0-linux-x64/bin/node" --version)" = v24.22.0 ] || exit 1
mv -- "$stage/node-v24.22.0-linux-x64" "$runtime"
chmod -R go-w "$runtime"
chown -R root:root "$runtime"
# Explicit production install; no package lifecycle scripts or frontend build.
PATH="$runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin" timeout 180s "$runtime/bin/node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage" --omit=dev --ignore-scripts --bin-links=false --no-audit --no-fund >/dev/null
rm -- "$stage/node.tar.xz"
rm -- "$stage/code.tar.gz"
chmod -R go-w "$stage"
chown -R root:root "$stage"
chmod 0755 "$stage"
mv -- "$stage" "$code"
for account in chogcare chogcare-station; do
    if id "$account" >/dev/null 2>&1; then
        [ "$(id -u "$account")" -gt 0 ] && [ "$(id -gn "$account")" = "$account" ] || exit 1
        [ "$(getent passwd "$account" | cut -d: -f6)" = "/var/lib/$account" ] || exit 1
        [ "$(getent passwd "$account" | cut -d: -f7)" = /usr/sbin/nologin ] || exit 1
    else
        useradd --system --user-group --home-dir "/var/lib/$account" --shell /usr/sbin/nologin "$account"
    fi
done
for directory in /var/lib/chogcare /var/lib/chogcare/work /var/lib/chogcare/work/payments /var/lib/chogcare/work/payments/custody /var/lib/chogcare/work/payments/integrity /var/lib/chogcare/work/payments/backups /var/lib/chogcare/work/support; do
    install -d -o chogcare -g chogcare -m 0700 "$directory"
done
install -d -o chogcare-station -g chogcare-station -m 0700 /var/lib/chogcare-station
install -d -o root -g root -m 0700 /etc/chogcare-station
memory_kib=$(awk '$1=="MemTotal:"{print $2}' /proc/meminfo)
swap_kib=$(awk '$1=="SwapTotal:"{print $2}' /proc/meminfo)
if [ "$memory_kib" -le 1048576 ] && [ "$swap_kib" -lt 1048576 ]; then
    [ ! -e /swapfile.chogcare ] && [ ! -L /swapfile.chogcare ] || exit 1
    if awk '$1=="/swapfile.chogcare"{found=1} END{exit !found}' /etc/fstab; then exit 1; fi
    free_kib=$(df -Pk / | awk 'NR==2{print $4}')
    [ "$free_kib" -ge 2097152 ] || exit 1
    (umask 077; fallocate -l 1073741824 /swapfile.chogcare)
    chmod 0600 /swapfile.chogcare
    mkswap /swapfile.chogcare >/dev/null
    swapon /swapfile.chogcare
    printf '\n/swapfile.chogcare none swap sw 0 0\n' >> /etc/fstab
fi
for unit in chogcare-payments.service chogcare-station.service; do
    install -o root -g root -m 0644 "$code/ops/payments/$unit" "/etc/systemd/system/$unit"
done
timeout 10s systemctl daemon-reload
timeout 10s systemd-analyze verify /etc/systemd/system/chogcare-payments.service /etc/systemd/system/chogcare-station.service >/dev/null 2>&1
# Never enable/start a payment unit or install an nginx route in this helper.
"$runtime/bin/node" "$code/ops/payments/readiness-preflight.mjs" --check
echo 'Generic code staging complete. Both payment units remain disabled; custody/state transfer still requires separate explicit approval.'
