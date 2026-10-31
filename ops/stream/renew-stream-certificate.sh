#!/bin/sh
set -eu
# systemd credentials are snapshots. Refresh only this stream origin when its
# own certificate was renewed; other certificates and services are unrelated.
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/chogcare-relay)
    /usr/bin/systemctl try-restart chogcare-stream.service
    ;;
esac
