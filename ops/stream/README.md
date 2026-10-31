# Server stream origin

The new delivery path is OBS → one authenticated RTMPS connection → MediaMTX on
the server → loopback HLS → existing public HTTPS → viewer. Viewer requests do
not travel back to the source computer, Funnel or the SSH relay. The source
uplink carries one encoded stream regardless of viewer count. A source uplink
failure still stops new video; the server must report it rather than repeat an
offline image as LIVE.

This profile is prepared for MediaMTX **1.21.3**. It remuxes H.264/AAC and does not
transcode. OBS must produce a one-second keyframe interval, no B frames, and a
bitrate the source upload can sustain. One-second segments and 200 ms parts set
the packaging target; source GOP, player buffering and network throughput still
determine measured end-to-end delay. The seven-segment window does not promise
seven seconds of viewing latency.

## Configuration and credentials

`mediamtx-config.mjs` returns JSON, which MediaMTX reads as YAML. Its required
inputs are a dedicated publisher's `sha256:BASE64` password hash and a separate
`hlsReadToken` containing 32 random bytes encoded as canonical base64url. The
publisher password should also contain at least 32 random bytes. Generate both
privately; do not reuse payment, wallet, relay or account credentials. The
publisher can publish only `station` and cannot replace an active publisher.
Other stream paths and all control APIs are disabled.

The production defaults are authenticated RTMPS on TCP 1936 and HLS bound only
to `127.0.0.1:8888`. Plain RTMP, RTSP, SRT, WebRTC and MoQ are disabled. Listener
port overrides and a loopback RTMPS bind support isolated integration tests.
They are not instructions to expose additional production ports.

MediaMTX 1.21.3 normally creates viewer sessions, cookies and an internal-path
redirect. `hlsCDNSecret` and nginx's matching private bearer header select its
CDN mode, so all viewers can use `/live/station/index.m3u8` without redirecting
to `/station/` or adding session identifiers to media URLs. The reader token
never enters a browser response. nginx removes browser authorization, checkout
cookies and proxy identity before injecting that header. HLS remains loopback
only, and the public route exposes only media files under this one path.

Store the generated MediaMTX JSON and generated nginx configuration outside
Git in root-owned, owner-readable files. The JSON contains a password verifier
and a bearer token and must be treated as private. Neither configuration,
credential, OBS stream key nor diagnostic log belongs in command output.

The unit loads `/etc/chogcare-stream/mediamtx.json` and the existing certificate
through systemd credentials. `DynamicUser` receives only its private credential
copies; the certificate key's original permissions stay private. A certificate
renewal hook must restart **only** `chogcare-stream.service` after a successful
renewal because systemd copies credentials at service start. Install the
root-owned `renew-stream-certificate.sh` in Certbot's deploy-hook directory;
it uses `try-restart` only for this exact certificate lineage. The certificate
name in the unit must match the reviewed installation. Do not relax certificate
verification in OBS. Confirm its normal TLS validation against the exact
configured public identity before rollout.

The process has a 160 MiB memory ceiling, a 112 MiB Go memory target, a 64-packet
write queue and a 2 MiB maximum per segment. It stores no recordings and runs no
external hooks. These bounds protect a small host; a publisher that exceeds
them can be disconnected instead of growing an unbounded queue. Unit stdout
and stderr are discarded to avoid persisting stream credentials in logs.

## Additive HTTPS route

`renderServerMediaRelayNginx` adds `/live/station/` to the existing resilient
relay. The old `/hls/`, payment route, TLS verification, certificate paths and
global request guards remain byte-identical. `renderServerMediaLocation`
provides just the new location for a reviewed runtime adapter when the existing
installation has additional cache directives. Do not replace such a deployed
configuration with a fresh generic renderer and silently discard its settings.

The new route accepts GET/HEAD for direct-child media filenames, preserves
LL-HLS query arguments, and uses one fixed loopback upstream. It has no fallback
to old video. It disables caching and proxy buffering, including CDN caching,
so a restarted muxer cannot reuse an old initialization file. All security
headers are repeated where local cache headers replace nginx inheritance.
HEAD is sent upstream as GET because MediaMTX's HLS handler implements GET;
nginx suppresses the response body for the client.

## Rollout and rollback

1. Verify the official release archive against both the release checksum file
   and the independently recorded Linux amd64 SHA-256:
   `0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635`.
   Install the verified binary as root-owned, non-writable
   `/opt/chogcare-stream/mediamtx`. Keep the downloaded archive out of Git.
2. Review the private generated configuration, new dedicated publisher
   credential, fixed ingest listener, firewall scope and source OBS settings
   before enabling the service. No payment custody or signing state is part of
   this service. Preserve exact backups and hashes of all existing runtime
   files before the additive nginx change; require the expected old hashes.
3. Run an isolated synthetic publisher first. Check valid and invalid auth,
   rejection of other paths/plaintext protocols, advancing LL-HLS playlists,
   init files/parts, query-preserving proxying and source disconnect behavior.
4. Start the new server origin in parallel, leaving the old pipeline active.
   Validate nginx configuration before a graceful reload. Verify the new path
   through the actual public site, decoded moving frames and measured capture
   timestamps over a sustained run, including source reconnect and viewport
   return. A successful HTTP response alone does not establish healthy video.
5. Switch the client to the new versioned path only after that evidence is
   satisfactory. On failure, restore the previous client selection and exact
   nginx backup, validate and reload. Stop only the new origin if necessary;
   preserve old video and all payment processes/state. Rotate the dedicated
   stream credentials if their private handling was compromised.

The official [configuration reference](https://github.com/bluenviron/mediamtx/blob/v1.21.3/mediamtx.yml),
[authentication guide](https://mediamtx.org/docs/features/authentication),
[HLS guide](https://mediamtx.org/docs/read/hls), and
[OBS guide](https://mediamtx.org/docs/publish/obs-studio) describe the pinned
server's supported behavior. Runtime installation, credentials and public
listener activation require a separate reviewed rollout; this source module
does not perform them.
