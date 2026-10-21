# Public HTTPS relay

This VPS holds only nginx, its TLS certificate and an SSH reverse-forward
listener. Owncast, the payment worker and all payment/custody state stay on the
existing computer. No database, invoice reference, stream key, admin password
or payment credential belongs on the relay or in this directory.

The traffic path is:

```text
Browser -> chogcare.xyz / Vercel same-origin rewrites
        -> HTTPS to the VPS public IPv4, certificate verified normally
        -> VPS 127.0.0.1:18090
        -> SSH reverse forward
        -> existing local 127.0.0.1:8090 gateway
        -> existing HLS files or loopback payment worker
```

This replaces the public transport to the existing gateway. It does not move
the worker, change payment validation or expose Owncast's interface. A relay
cannot provide live video or issue new payment requests while that computer,
its worker or the reverse tunnel is offline.

## Render the nginx configuration

`nginx-config.mjs` exports two pure functions:

```js
import { renderBootstrapNginx, renderRelayNginx } from "./nginx-config.mjs";

const bootstrap = renderBootstrapNginx({ publicIp });
const production = renderRelayNginx({
  publicIp,
  certificateName: "chogcare-relay",
});
```

The operator supplies the real public IPv4 at deployment time. The renderer
accepts a canonical public IPv4 only, and rejects private, loopback, shared,
link-local, documentation, multicast and other special ranges. The certificate
name is a bounded lowercase name containing only letters, digits and internal
hyphens. Neither parameter can inject nginx directives or a filesystem path.
Do not commit generated configurations, host inventory, SSH credentials or
certificate material. The certificate name defaults to `chogcare-relay`.

Each result is an **http-context include**, for example the one site file
loaded by `/etc/nginx/conf.d/`. Install the bootstrap result first; after
certificate issuance replace that same file with the production result.
Do not load both results at once: they define the same maps and default HTTP
listener. Remove the distribution's unused default site before validating
the replacement. Preserve a private backup, run `nginx -t`, then reload nginx
gracefully. The generated configuration works with nginx 1.24 and newer; it
does not depend on the newer `http2 on` directive.

## IP certificate and renewal

Let's Encrypt supports public IP certificates through the `shortlived`
profile. They are valid for **160 hours**, so unattended renewal and a tested
nginx reload hook are required. Certbot **5.4 or newer** supports IP addresses
with the webroot plugin; its nginx installer is not required. See the official
[Certbot/IP instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
and [certificate lifetime announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).

Use a maintained Certbot installation and verify its version. Create the
webroot `/var/lib/chogcare-relay/acme` with directories readable/traversable by
nginx and writable only by the certificate operator. Certbot writes its token
under `.well-known/acme-challenge/`. Port 80 must remain reachable for this
challenge during both initial issuance and renewal. The HTTP server serves
only a single valid challenge token, never API/HLS traffic or a general file
tree; other requests return 404. Symlink challenge files are refused.

With the operator's `PUBLIC_IPV4` set privately, the relevant issuance options
are:

```sh
certbot certonly \
  --webroot --webroot-path /var/lib/chogcare-relay/acme \
  --ip-address "$PUBLIC_IPV4" \
  --cert-name chogcare-relay \
  --preferred-profile shortlived \
  --deploy-hook 'nginx -t && systemctl reload nginx'
```

Complete ACME account registration privately if needed. Exercise staging
issuance first without replacing the production certificate with an untrusted
staging certificate. Public certificate issuance also makes the IP identifier
public in certificate transparency logs. No contact address or account key
needs to be copied into this repository.

The production renderer reads only:

```text
/etc/letsencrypt/live/chogcare-relay/fullchain.pem
/etc/letsencrypt/live/chogcare-relay/privkey.pem
```

Keep the private key restricted to the certificate/nginx operator. Enable the
installation's existing Certbot renewal timer, preserve `shortlived` and the
reload hook in its renewal parameters, and verify a staging renewal with
`certbot renew --dry-run --run-deploy-hooks`. Monitor certificate expiry as
well as the timer's success. A successful issuance alone does not establish
that future renewals or reloads work.

Literal-IP TLS clients usually send no DNS SNI. The TLS server therefore uses
`listen 443 ssl default_server` and presents the valid IP certificate. It must
not use `ssl_reject_handshake` on that listener. After TLS, only an exact HTTP
Host equal to the configured IP or `IP:443` is accepted. Port 80 accepts the
same IP with an optional `:80`. Wrong hosts, ports and missing hosts cannot
reach the reverse tunnel. Certificate verification stays enabled on Vercel
and all health checks.

## Reverse tunnel boundary

Run the tunnel from the local environment that can already reach
`127.0.0.1:8090`. In the current deployment that is WSL, alongside nginx.
The remote forward is exactly:

```text
-N -T -R 127.0.0.1:18090:127.0.0.1:8090
```

The VPS listener must bind to loopback, never a public interface. Use a
dedicated unprivileged SSH account/key and a pinned, independently verified
server host key. Do not use password authentication, agent forwarding or
`StrictHostKeyChecking=no`. The supervised client needs
`ExitOnForwardFailure=yes`, bounded keepalives and automatic retry if the
network disappears. Its private key and known-hosts file stay outside Git.
Never print the private key or the server's general SSH configuration while
checking the tunnel.

On the server, constrain this account to remote forwarding only:
`AllowTcpForwarding remote`, `PermitListen 127.0.0.1:18090`, `GatewayPorts no`,
`PermitOpen none`, `MaxSessions 0`, `PermitTTY no`,
`AllowAgentForwarding no` and `X11Forwarding no`. A key using `restrict` also
needs the explicit `port-forwarding` option to permit the intended listener;
combine it with `permitlisten="127.0.0.1:18090"` and the account restrictions.
Do not grant a shell or unrestricted forwarding to make a failed tunnel work.

## Public request boundary

HTTPS exposes only `/hls/` with GET/HEAD and `/api/payments/` with
GET/HEAD/POST. The API body limit remains 4 KiB. OPTIONS and other methods are
rejected, matching the existing local gateway. The bare `/hls` and
`/api/payments` paths explicitly return 404 instead of nginx's automatic
prefix redirect. Admin, status, websocket, metrics and every other path return
404. The original path rejects percent encoding, backslashes, doubled slashes
and dot segments before another proxy can interpret them; query values are
unaffected.

The fixed upstream is always `http://127.0.0.1:18090`; no request header or URL
selects a destination. Upstream `X-Accel-Redirect` cannot initiate an internal
redirect. The relay resets forwarded client-identity headers and passes the
original Origin, Cookie and Idempotency-Key with `Host: chogcare.xyz` and
`X-Forwarded-Proto: https`. Existing signed-session, browser-origin,
idempotency, readiness and replay checks still run at the payment worker.
The relay does not add cross-origin API permissions.

Security headers also cover rejected paths. HLS MIME/CORS and cache headers
come from the existing gateway: playlists/previews remain fresh and completed
mobile segments retain their existing short public cache policy. There is no
second proxy cache. Access logs are off, error output is discarded, response
and request buffering are disabled, and proxy temporary response files are
disabled. Do not enable verbose request logging to diagnose payment failures:
paths, cookies and bodies can contain private recovery material.

## Verification

Run the source/security checks on pinned Node 24:

```text
node --test test/public-relay.test.mjs
```

On Linux the test uses a real nginx if nginx, OpenSSL and Python are installed.
On Windows, set `CHOGCARE_RELAY_WSL_TEST=1` to run that test in WSL Ubuntu.
It creates an isolated nginx prefix, a dummy local upstream, random loopback
ports and a temporary test-only certificate. It does not read production keys,
change a trust store, reload the active nginx, contact an ACME/RPC service or
send requests to a real payment worker. The fixture is removed afterward.

Before switching the site's two rewrites, verify the live relay through normal
TLS, then confirm safe payment readiness fields, two advancing HLS samples
and actual browser playback. Also confirm admin/other paths return 404 and a
wrong HTTP Host is rejected. Record only status, timing and allowlisted flags;
do not publish response bodies, cookie headers or invoice URLs. Keep the prior
rewrite target available for an explicit rollback until the new transport has
been observed working continuously. Rollback changes only transport, never
payment state or custody records.
