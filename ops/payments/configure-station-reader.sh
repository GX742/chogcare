#!/bin/sh
# APPROVED CUTOVER ONLY. Changes access metadata, never financial contents.
set -eu
[ "$(id -u)" = 0 ] || exit 1
command -v setfacl >/dev/null
id chogcare >/dev/null 2>&1
id chogcare-station >/dev/null 2>&1
if systemctl is-active --quiet chogcare-payments.service; then
    echo 'Stop custody gracefully before configuring the station reader.' >&2
    exit 1
fi
if systemctl is-active --quiet chogcare-station.service; then
    echo 'Stop the station feed before changing its source access.' >&2
    exit 1
fi
for directory in /var/lib/chogcare /var/lib/chogcare/work /var/lib/chogcare/work/payments; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || exit 1
    [ "$(stat -c %U "$directory")" = chogcare ] || exit 1
done
for database in /var/lib/chogcare/work/payments/processor.sqlite /var/lib/chogcare/work/payments/preview.sqlite; do
    [ -f "$database" ] && [ ! -L "$database" ] || exit 1
    [ "$(stat -c %h "$database")" = 1 ] || exit 1
    [ "$(stat -c %U "$database")" = chogcare ] || exit 1
done
for directory in /var/lib/chogcare /var/lib/chogcare/work /var/lib/chogcare/work/payments; do
    setfacl -m u:chogcare-station:--x "$directory"
done
# SQLite inherits the main file's access mask when it recreates WAL/SHM.
# Named default ACLs preserve the reader on those replacement files. Existing
# custody/integrity/backup subdirectories retain their private 0700 boundary.
setfacl -m d:u::rwx,d:g::---,d:o::---,d:u:chogcare-station:r--,d:m::r-- /var/lib/chogcare/work/payments
for database in /var/lib/chogcare/work/payments/processor.sqlite /var/lib/chogcare/work/payments/preview.sqlite; do
    for file in "$database" "$database-wal" "$database-shm"; do
        if [ -e "$file" ] || [ -L "$file" ]; then
            [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %h "$file")" = 1 ] || exit 1
            setfacl -m u:chogcare-station:r-- "$file"
        fi
    done
done
echo 'Station reader access configured; no financial rows or custody files changed.'
