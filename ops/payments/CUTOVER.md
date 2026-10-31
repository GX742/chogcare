# Single payment host and remote station cutover

This is a staged procedure. Publishing this code or installing disabled units
does not authorize copying private state, retiring the current host, changing
active custody paths, or starting the cloud signer. Obtain the owner's explicit
approval for that exact batch after the code, TLS, resources and tests are ready.
The owner enters the existing password only in their own hidden local/SSH prompt.

## Architecture and remaining dependencies

The public payment API and both existing processors move together to one Linux
host. Vercel already routes `/api/payments/:path*` to the existing verified HTTPS
origin `https://45.38.60.159`; cutover changes that origin's payment upstream to
its local worker without adding a DNS/certificate prerequisite.
There is no remote-signing protocol or active/active database replication. The
4175 lease protects one host only. Cloud transport removes the workstation,
desktop application, VPN and reverse tunnel from public payment reachability.
RPCs, quotes, gas, chain finality and their existing fail-closed checks remain.
Healthy config is not evidence of a successful new quote or settlement.

`chogcare-station.service` runs as a separate user without a vault/credential or
writable financial connection. It reads the paired financial databases, keeps
its own presentation outbox, and exposes only authenticated loopback next/ACK
routes. Nginx provides TLS for the two exact `/api/station/v1/` paths. Firmware
continues receiving the same sanitized stable gratitude IDs. A station/network
outage never blocks payment processing. Camera/OBS and USB remain physical-source
dependencies; moving payments does not keep a powered-off camera broadcasting.
In explicit remote station mode, its screen's video flag follows the fixed public
`/live/station/index.m3u8` and at most one validated direct-child variant. It sends
no station bearer, requires observed media/part advancement, and expires a frozen
200 playlist after a finite 15s window. This is source transport/freshness evidence,
not a claim that viewers decoded frames. Video probing never gates gratitude or
payment health. Legacy local mode continues using local Owncast status.

## Before any private transfer

1. Install the code-only archive, locked runtime dependencies, Node 24.22+ in
   major 24, nginx/TLS, systemd tools and `acl`. Keep code root-owned and
   nonwritable by service users. Create separate `chogcare` and
   `chogcare-station` users and private state directories. Do not start either
   service and do not copy a vault or financial state during preparation.
   Put the public code-only archive at the fixed
   `/var/tmp/chogcare-code/code.tar.gz` path (root-owned 0600, one link) inside
   root-owned 0700 `/var/tmp/chogcare-code` with no symlink. Then
   `sh ops/payments/provision-stage.sh --stage-only /var/tmp/chogcare-code/code.tar.gz <sha256>` is
   the reviewable generic helper. The verifier consumes bounded stdin rather
   than accepting filesystem paths and creates one exclusive fixed-name copy
   in a checked private staging directory. It validates every archive path/hash, installs
   pinned official Node 24.22.0 under `/opt/chogcare-node-v24.22.0` without replacing
   system Node, creates empty private directories/users, provisions at most one
   new swapfile with at least 1 GiB usable capacity on a low-memory host (1 GiB +
   1 MiB allocated for the header), and installs disabled units. It refuses
   existing code/runtime/unit paths or private files. It never reads/copies source
   state, provisions a token/password, starts/enables workers or publishes nginx.
   The helper is not resumable after a partial failure: review the exact staged
   files first rather than deleting an ambiguous target automatically.
   The Linux x64 archive hash was checked against the
   [official Node checksums](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt):
   `cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008`.
2. Run `node ops/payments/readiness-preflight.mjs --check` on Linux. This reads
   fixed OS/proc and file metadata only. Its output explicitly does not assess
   payment readiness or authorize custody. Missing state directories can be
   prepared empty. A 1 GiB host requires at least 1 GiB swap, 512 MiB available
   memory and 512 MiB disk headroom; keep additional backup headroom. The known
   small host has no swap yet, so this gate must fail until swap is provisioned.
   Measure actual worker RSS and peak combined load; use remux-only video,
   separate limits and no frontend build or CPU transcoding on this host.
3. Validate both units using `systemd-analyze verify` and TLS/nginx with `nginx -t`.
   Custody uses `SendSIGKILL=no`: an overdue drain requires operator attention,
   not a forced kill. A stop command alone does not prove a graceful stop.
4. Run isolated code tests. The real Linux ACL regression uses only temporary
   synthetic databases and a dropped UID; it proves readonly access survives
   WAL/SHM recreation and cannot read custody. On Windows explicitly set
   `CHOGCARE_STATION_WSL_TEST=1`; Linux runs it natively (root or passwordless
   sudo for the temporary UID drop). No production state belongs in these tests.

## Owner-approved maintenance and transfer

1. Gracefully stop the USB bridge and Admin, including its signer-free support
   fallback, then the original payment worker if externally owned. Preserve OBS
   and the stream. Verify the worker really drained and ports 4174/4175 are free.
   Stop support intake and station writes for consistent separate snapshots.
2. From the original workspace, run the checked release's
   `node ops/payments/retire-host.mjs --retire-host --release <checked-commit>`.
   It owns the local lease, checks current paired integrity, checks the password
   offline, creates a fresh complete encrypted backup, verifies an isolated
   restore, then writes `work/payments/integrity/host-retired.json` durably.
   Its private marker binds the checked commit and exact backup digest. It does
   not transfer, replace or move live files, start processors or broadcast.
   Malformed/linked retirement metadata also blocks startup before password/state
   access. Updated Admin refuses to fork a retired local payment worker.
3. Preserve an independent encrypted off-device recovery copy. Privately transfer
   the consistent paired processor/request databases, encrypted vault and original
   checkpoint. Preserve committed WAL content using proper SQLite snapshots;
   never copy an active `.sqlite` alone. Transfer `support.sqlite` separately with
   its own coherent snapshot and private ownership: support/contact history is
   deliberately outside the financial recovery bundle. No contents or private
   invoice references may enter console logs, Git, issues or chat.
4. Also snapshot the stopped station's existing `work/station/station.sqlite`,
   including WAL. Transfer it as `/var/lib/chogcare-station/station.source.sqlite`.
   Do not initialize a new outbox at the current tail or discard pending ACKs.
5. Before cloud activation, under the same explicit approval, move the OLD host's
   active encrypted `work/payments/custody/vault.json` into a protected retained
   `work/payments/retired-recovery/<migration-id>/custody/` location. Verify the
   resolved source/destination stay within the intended private recovery tree,
   preserve the backup, use private ACLs, and confirm the old default vault path
   is absent. This blocks older binaries that do not know the retirement marker.
   Never transfer the old host-retired marker into the destination integrity dir.

## Destination checks before signing

1. Put state under `/var/lib/chogcare/work`, owned by `chogcare`, directories 0700
   and files 0600. Keep the old checkpoint as
   `work/payments/integrity/checkpoint.source.json`. Run the existing
   `scripts/relocate-payment-checkpoint.mjs --verify-relocation` as `chogcare`
   with cwd `/var/lib/chogcare`. It verifies both logical database digests against
   the original checkpoint before changing only path binding. Never enroll or
   reset a checkpoint to bypass mismatch.
2. As root, before either service starts, run
   `node /opt/chogcare-payments/ops/payments/relocate-station-outbox.mjs --verify-relocation`.
   This requires free worker/API/station ports, verifies the exact old financial
   source and new checkpoint, checks the old sidecar binding/cursor, then creates
   a new sidecar with the new path binding. Pending/completed IDs and payloads
   remain. It refuses an existing target. Set only the resulting station sidecar
   owner/group to `chogcare-station`, mode 0600, parent 0700. Preserve source snapshots.
3. Run `sh ops/payments/configure-station-reader.sh` only after approval while both
   services are stopped. It grants the station user traverse-only access on the
   three financial ancestors, readonly named access on the two SQLite files and
   current journals, and readonly default ACLs for replacement WAL/SHM. Custody,
   integrity, backups and support subdirectories remain private. The station
   unit additionally hides them and allows network traffic only on loopback.
   Verify real access after the cloud worker creates journals; any failure holds
   the station and must not be bypassed by changing payment readiness.
4. The owner creates the existing custody password credential in their own SSH
   terminal using `systemd-ask-password` piped to `systemd-creds encrypt`, as in
   `docs/PAYMENT-SERVER.md`. Never use argv, environment, chat or plaintext files.
   VPS administrator/provider access becomes part of the custody trust boundary.
5. Generate a separate random 256-bit station bearer token into a root-only file
   `/etc/chogcare-station/token`, directory 0700/file 0600; never print it. systemd
   supplies it via `LoadCredential` to the signer-free unit. Privately provision
   Windows `work/station/remote.json` as exactly `{version:1,origin,token}` with
   origin `https://45.38.60.159`. Values belong only in the private file, not
   this document or command arguments. Protect its DACL against inherited/broad
   read access; the reader checks it. Existing local behavior remains until this
   explicit file is present. Malformed/private-permission failures hold the bridge,
   never silently fall back to the old payment host. Retain local remote-ACK SQLite.

## Activation, evidence and rollback

Only now activate ONE cloud custody worker. Startup can resume existing signed
transactions. Check actual version/readiness and original invoice states privately,
without creating test invoices, moving funds or overriding gas/network gates.
Start the station feed, verify authenticated exact HTTPS routes, then reconnect
COM6 using its private remote config. Its durable local ACK ledger retries lost
ACKs without replaying USB; ineligible reorg ACKs retain dedup tombstones and are
retried separately while later eligible gratitude continues.

Switch only the payment upstream after direct HTTPS is healthy; keep the existing
public rewrite when it already targets this HTTPS origin. Do not add
POST retries to another payment backend. Check repeated safe config metadata,
TLS/host/path guards and controlled restart/reboot recovery. Keep route cost policy,
original issued minimums, signatures, recipients, request identities, paid/replay
and finality checks unchanged. Transport improvements cannot certify provider uptime.

Rollback begins by stopping the cloud signer and feed gracefully. Never remove
the original fence to restart a stale database. Restore the LATEST coherent paired
state/checkpoint, station completion ledger and support snapshot, verify against
chain history, and obtain explicit operator authorization for the intended active
host. There is deliberately no automatic unretire, active/active or stale failover.
