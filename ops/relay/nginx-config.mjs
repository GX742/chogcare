import { isIP } from "node:net";
import { streamListenerPort, streamPathSegment, streamReadToken } from "../stream/mediamtx-config.mjs";

const DEFAULT_CERTIFICATE_NAME = "chogcare-relay";

function publicIpv4(value) {
  if (typeof value !== "string" || isIP(value) !== 4) throw new Error("A canonical public IPv4 address is required.");
  const [a, b, c] = value.split(".").map(Number);
  // Fail closed on private, shared, loopback, link-local, documentation,
  // benchmarking, multicast and reserved ranges. No hostnames or URLs enter
  // nginx configuration or certificate paths through this renderer.
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 168) || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) ||
      (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) throw new Error("A public unicast IPv4 address is required.");
  return value;
}

function certificateSegment(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error("The certificate name must be a safe lowercase name.");
  }
  return value;
}

const securityHeaders = `    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;`;

function guards(ip, https = false) {
  return `# Included inside nginx's http context. Inputs are validated by the renderer.
map $http_host $chogcare_relay_http_host_ok {
    default 0;
    "${ip}" 1;
    "${ip}:80" 1;
}
${https ? `map $http_host $chogcare_relay_https_host_ok {
    default 0;
    "${ip}" 1;
    "${ip}:443" 1;
}
` : ""}
# Inspect the original path before nginx normalizes it. Public HLS filenames,
# ACME tokens and payment API paths need no percent encoding, backslashes or
# dot segments. Reject those spellings before a second proxy can decode them.
# Query values are unaffected.
map $request_uri $chogcare_relay_unsafe_path {
    default 0;
    ~^[^?]*% 1;
    "~^[^?]*\\\\\\\\" 1;
    ~^[^?]*// 1;
    "~^[^?]*/\\\\.\\\\.?(/|\\\\?|$)" 1;
}
map $request $chogcare_relay_origin_form {
    default 0;
    "~^[A-Z]+ /" 1;
}
`;
}

function httpServer(ip) {
  return `server {
    listen 80 default_server;
    server_name ${ip};
    server_tokens off;
    access_log off;
    error_log /dev/null emerg;
    client_max_body_size 4k;
    client_body_timeout 8s;
    if ($chogcare_relay_http_host_ok = 0) { return 404; }
    if ($chogcare_relay_unsafe_path = 1) { return 404; }
    if ($chogcare_relay_origin_form = 0) { return 404; }
${securityHeaders}
    add_header Cache-Control no-store always;

    # Certbot webroot keeps renewal available without stopping HTTPS.
    # A single token file is the only public plaintext resource.
    location ~ "^/\\\\.well-known/acme-challenge/[A-Za-z0-9_-]{1,256}$" {
        limit_except GET { deny all; }
        root /var/lib/chogcare-relay/acme;
        types { }
        default_type text/plain;
        autoindex off;
        disable_symlinks on;
        try_files $uri =404;
    }

    location / { return 404; }
}
`;
}

/** HTTP-only bootstrap; the same ACME server remains after TLS is installed. */
export function renderBootstrapNginx({ publicIp } = {}) {
  const ip = publicIpv4(publicIp);
  return `${guards(ip)}\n${httpServer(ip)}`;
}

/** Narrow TLS relay; the SSH listener must stay bound to VPS loopback. */
export function renderRelayNginx({ publicIp, certificateName = DEFAULT_CERTIFICATE_NAME } = {}) {
  const ip = publicIpv4(publicIp);
  const certificate = certificateSegment(certificateName);
  return `${guards(ip, true)}
${httpServer(ip)}
server {
    # Literal-IP HTTPS clients do not send DNS SNI. The default listener must
    # present this IP certificate, then enforce the exact HTTP Host below.
    listen 443 ssl default_server;
    server_name ${ip};
    ssl_certificate /etc/letsencrypt/live/${certificate}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certificate}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5:!3DES;
    ssl_session_tickets off;
    server_tokens off;
    access_log off;
    error_log /dev/null emerg;
    if ($chogcare_relay_https_host_ok = 0) { return 404; }
    if ($chogcare_relay_unsafe_path = 1) { return 404; }
    if ($chogcare_relay_origin_form = 0) { return 404; }
${securityHeaders}

    client_max_body_size 4k;
    client_body_buffer_size 4k;
    client_body_timeout 8s;
    client_body_in_file_only off;
    proxy_http_version 1.1;
    proxy_set_header Host chogcare.xyz;
    proxy_set_header Connection "";
    proxy_set_header Upgrade "";
    proxy_set_header X-Forwarded-Proto https;
    # The worker uses its signed session, never client-supplied proxy identity.
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Port "";
    proxy_set_header Origin $http_origin;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Idempotency-Key $http_idempotency_key;
    proxy_connect_timeout 3s;
    proxy_read_timeout 60s;
    proxy_send_timeout 10s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_max_temp_file_size 0;
    proxy_cache off;
    proxy_redirect off;
    proxy_ignore_headers X-Accel-Redirect;
    proxy_hide_header X-Accel-Redirect;
    proxy_hide_header Server;
    proxy_hide_header X-Powered-By;
    # Emit one copy of the data-only security headers, including on rejections.
    # MIME, CORS and freshness headers still come from the existing gateway.
    proxy_hide_header X-Content-Type-Options;
    proxy_hide_header Referrer-Policy;
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Content-Security-Policy;
    proxy_hide_header Permissions-Policy;

    # Prefix proxy locations otherwise make nginx redirect their bare prefix.
    location = /hls { return 404; }
    location = /api/payments { return 404; }

    location ^~ /hls/ {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:18090;
    }

    location ^~ /api/payments/ {
        limit_except GET POST { deny all; }
        proxy_pass http://127.0.0.1:18090;
    }

    location / { return 404; }
}
`;
}

/** Optional HTTPS transport through an already configured, owner-approved Funnel. */
export function renderFunnelRelayNginx({ publicIp, certificateName = DEFAULT_CERTIFICATE_NAME, funnelHostname } = {}) {
  // Exactly a machine and tailnet label under ts.net. Compare the complete
  // match as well: JavaScript's $ alone also accepts a trailing newline.
  const hostnameMatch = typeof funnelHostname === "string"
    ? funnelHostname.match(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/)
    : null;
  if (!hostnameMatch || hostnameMatch[0] !== funnelHostname) {
    throw new Error("A lowercase two-label Funnel hostname under ts.net is required.");
  }
  const canonical = renderRelayNginx({ publicIp, certificateName });
  const originalHost = "    proxy_set_header Host chogcare.xyz;";
  const originalTarget = "proxy_pass http://127.0.0.1:18090;";
  const originalConnectTimeout = "    proxy_connect_timeout 3s;";
  // Keep the canonical public boundary byte-for-byte. A future template
  // change must be reviewed before this transport substitution can proceed.
  if (canonical.split(originalHost).length !== 2 || canonical.split(originalTarget).length !== 3 || canonical.split(originalConnectTimeout).length !== 2) {
    throw new Error("The canonical relay transport template has changed.");
  }
  const tlsHost = `    proxy_set_header Host ${funnelHostname};
    proxy_ssl_server_name on;
    proxy_ssl_name ${funnelHostname};
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;`;
  return `upstream chogcare_funnel_upstream {
    server ${funnelHostname}:443;
    keepalive 16;
}

${canonical.replace(originalHost, tlsHost)
  .replace(originalConnectTimeout, "    proxy_connect_timeout 10s;")
  .replaceAll(originalTarget, "proxy_pass https://chogcare_funnel_upstream;")}`;
}

/** HLS can fail over between the two existing transports to the same gateway. */
export function renderResilientHlsRelayNginx(options = {}) {
  // Reuse the existing strict hostname, certificate and public-route validation.
  const canonical = renderFunnelRelayNginx(options);
  const original = `    location ^~ /hls/ {
        limit_except GET { deny all; }
        proxy_pass https://chogcare_funnel_upstream;
    }`;
  if (canonical.split(original).length !== 2) throw new Error("The canonical HLS route has changed.");
  return canonical.replace(original, `    location ^~ /hls/ {
        limit_except GET { deny all; }
        # Reuse the existing verified peer and HTTP/1.1 keepalive pool.
        proxy_connect_timeout 10s;
        proxy_read_timeout 15s;
        proxy_next_upstream off;
        proxy_intercept_errors on;
        error_page 502 503 504 = @chogcare_hls_ssh;
        proxy_pass https://chogcare_funnel_upstream;
    }

    location @chogcare_hls_ssh {
        internal;
        limit_except GET { deny all; }
        proxy_connect_timeout 3s;
        proxy_read_timeout 15s;
        proxy_next_upstream off;
        proxy_intercept_errors off;
        proxy_pass http://127.0.0.1:18090;
    }`);
}

/** Server-local LL-HLS, with the two legacy transports left intact. */
export function renderServerMediaLocation({ streamPath = "station", hlsPort = 8888, hlsReadToken } = {}) {
  const path = streamPathSegment(streamPath);
  const port = streamListenerPort(hlsPort);
  const token = streamReadToken(hlsReadToken);
  return `    location = /live { return 404; }
    location = /live/${path} { return 404; }
    location ^~ /live/${path}/ {
        limit_except GET { deny all; }
        # MediaMTX emits direct-child playlists, initialization files and parts.
        # Queries, including LL-HLS blocking reload parameters, pass unchanged.
        if ($uri !~ "^/live/${path}/[A-Za-z0-9_-]{1,160}\\\\.(m3u8|mp4|m4s|ts)$") { return 404; }
        proxy_connect_timeout 1s;
        proxy_read_timeout 8s;
        proxy_send_timeout 5s;
        proxy_next_upstream off;
        proxy_intercept_errors off;
        # MediaMTX's HLS handler implements GET. nginx removes the response body
        # for a client HEAD while keeping readiness checks equivalent to GET.
        proxy_method GET;
        proxy_cache off;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_pass_request_body off;
        # Defining one proxy header replaces nginx's entire inherited list.
        # Repeat every privacy reset; viewer checkout identity is unnecessary.
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Connection "";
        proxy_set_header Upgrade "";
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header X-Forwarded-Port "";
        proxy_set_header Origin "";
        proxy_set_header Cookie "";
        proxy_set_header Idempotency-Key "";
        proxy_set_header Content-Length "";
        proxy_set_header Authorization "Bearer ${token}";
        proxy_hide_header Cache-Control;
        proxy_hide_header CDN-Cache-Control;
        proxy_hide_header Vercel-CDN-Cache-Control;
${securityHeaders.replaceAll("    ", "        ")}
        add_header Cache-Control no-store always;
        add_header CDN-Cache-Control no-store always;
        add_header Vercel-CDN-Cache-Control no-store always;
        proxy_pass http://127.0.0.1:${port}/${path}/;
    }`;
}

export function renderServerMediaRelayNginx(options = {}) {
  const canonical = renderResilientHlsRelayNginx(options);
  const marker = "    location / { return 404; }\n}";
  const at = canonical.lastIndexOf(marker);
  if (at < 0 || at === canonical.indexOf(marker)) throw new Error("The canonical TLS relay boundary has changed.");
  return `${canonical.slice(0, at)}${renderServerMediaLocation(options)}\n\n${canonical.slice(at)}`;
}
