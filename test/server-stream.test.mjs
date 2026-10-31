import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderMediaMtxConfig, MEDIA_MTX_VERSION, MEDIA_MTX_LINUX_AMD64_SHA256 } from "../ops/stream/mediamtx-config.mjs";
import { renderResilientHlsRelayNginx, renderServerMediaRelayNginx, renderServerMediaLocation } from "../ops/relay/nginx-config.mjs";

const publisherPasswordHash = `sha256:${createHash("sha256").update("isolated-fixture-only").digest("base64")}`;
const hlsReadToken = createHash("sha256").update("isolated-reader-fixture-only").digest("base64url");
const relay = { publicIp: "8.8.8.8", funnelHostname: "example-node.example-tailnet.ts.net", hlsReadToken };
const origin = options => JSON.parse(renderMediaMtxConfig({ publisherPasswordHash, hlsReadToken, ...options }));
const mediaLocation = options => renderServerMediaLocation({ hlsReadToken, ...options });

test("server origin gives the publisher exactly one path and anonymous readers only loopback access", () => {
  const config = origin();
  assert.equal(config.authMethod, "internal");
  assert.deepEqual(config.authInternalUsers, [
    { user: "publisher", pass: publisherPasswordHash, ips: [], permissions: [{ action: "publish", path: "station" }] },
    { user: "any", pass: "", ips: ["127.0.0.1/32", "::1/128"], permissions: [{ action: "read", path: "station" }] },
  ]);
  assert.deepEqual(config.paths, { station: {} });
  assert.deepEqual(config.pathDefaults, { source: "publisher", overridePublisher: false, record: false, alwaysAvailable: false });
  assert.equal(origin({ streamPath: "fixture-2", publisherUser: "camera_2" }).authInternalUsers[0].permissions[0].path, "fixture-2");
});

test("server origin opens only strict RTMPS and loopback HLS", () => {
  const config = origin();
  assert.equal(config.rtmp, true);
  assert.equal(config.rtmpEncryption, "strict");
  assert.equal(config.rtmpsAddress, "0.0.0.0:1936");
  assert.equal(config.hlsAddress, "127.0.0.1:8888");
  assert.equal(config.hlsEncryption, false); // Existing public HTTPS terminates TLS.
  assert.deepEqual(config.rtmpTrustedProxies, []);
  assert.deepEqual(config.hlsTrustedProxies, []);
  assert.equal(config.hlsCDNSecret, hlsReadToken);
  for (const name of ["rtsp", "srt", "webrtc", "moq", "api", "metrics", "pprof", "playback"]) assert.equal(config[name], false, name);
  assert.deepEqual(config.hlsAllowOrigins, []);
  const fixture = origin({ rtmpsBindAddress: "127.0.0.1", rtmpsPort: 25193, hlsPort: 25888 });
  assert.equal(fixture.rtmpsAddress, "127.0.0.1:25193");
  assert.equal(fixture.hlsAddress, "127.0.0.1:25888");
});

test("server remuxing has bounded segments, queues and no offline LIVE substitute", () => {
  const config = origin();
  assert.equal(config.hlsAlwaysRemux, true);
  assert.equal(config.hlsVariant, "lowLatency");
  assert.equal(config.hlsSegmentCount, 7);
  assert.equal(config.hlsSegmentDuration, "1s");
  assert.equal(config.hlsPartDuration, "200ms");
  assert.equal(config.hlsSegmentMaxSize, "2M");
  assert.equal(config.hlsDirectory, "");
  assert.equal(config.writeQueueSize, 64);
  assert.equal(config.readTimeout, "15s");
  assert.equal(config.writeTimeout, "5s");
  assert.equal(config.pathDefaults.alwaysAvailable, false);
  assert.equal(config.pathDefaults.overridePublisher, false);
  assert.equal(config.dumpPackets, false);
  assert.doesNotMatch(JSON.stringify(config), /runOn|ffmpeg|sourceOnDemand|alwaysAvailableFile|recordPath/);
});

test("publisher credentials require canonical hashes and dedicated safe usernames", () => {
  for (const value of [undefined, null, "", "plain-password", "sha256:abc", publisherPasswordHash + "\n", publisherPasswordHash.replace(/.$/, "A"), `sha256:${"A".repeat(42)}B=`]) {
    assert.throws(() => renderMediaMtxConfig({ publisherPasswordHash: value, hlsReadToken }));
  }
  for (const publisherUser of ["any", "", "~.*", "../publisher", "a\n", "a b", "a".repeat(65), null]) {
    assert.throws(() => origin({ publisherUser }));
  }
  assert.equal(origin().authInternalUsers[0].pass, publisherPasswordHash);
  assert.equal(MEDIA_MTX_VERSION, "1.21.3");
  assert.match(MEDIA_MTX_LINUX_AMD64_SHA256, /^[a-f0-9]{64}$/);
  for (const token of [undefined, null, "", "short", hlsReadToken + "\n", `${"A".repeat(42)}B`, "A".repeat(44), `bad\"; include /tmp/other;`]) {
    assert.throws(() => origin({ hlsReadToken: token }));
    assert.throws(() => renderServerMediaLocation({ hlsReadToken: token }));
  }
});

test("path, listener and credential file values cannot widen exposure or inject configuration", () => {
  for (const streamPath of ["", ".", "..", "station/other", "~.*", "all", "all_others", "a\n", "a".repeat(65), null]) {
    assert.throws(() => origin({ streamPath }));
    assert.throws(() => mediaLocation({ streamPath }));
  }
  for (const port of [0, 80, 443, 1023, 65536, 1.5, "8888", null, NaN]) {
    assert.throws(() => origin({ hlsPort: port }));
    assert.throws(() => origin({ rtmpsPort: port }));
    assert.throws(() => mediaLocation({ hlsPort: port }));
  }
  assert.throws(() => origin({ hlsPort: 1936 }));
  for (const rtmpsBindAddress of ["", "::", "::1", "localhost", "8.8.8.8", "127.0.0.1\n"]) assert.throws(() => origin({ rtmpsBindAddress }));
  for (const file of ["", "tls.key", "/tmp/../key", "/tmp/./key", "/tmp//key", "/tmp/key\n", "/tmp/key;bad", "C:/key"]) {
    assert.throws(() => origin({ tlsKeyPath: file }));
    assert.throws(() => origin({ tlsCertificatePath: file }));
  }
  assert.equal(origin({ tlsKeyPath: "/tmp/fixture/key.pem" }).rtmpServerKey, "/tmp/fixture/key.pem");
});

test("new video route preserves the complete existing relay, payment and TLS boundary", () => {
  const canonical = renderResilientHlsRelayNginx(relay);
  const addition = mediaLocation();
  const config = renderServerMediaRelayNginx(relay);
  assert.equal(config.replace(`${addition}\n\n`, ""), canonical);
  assert.equal(config.split(addition).length, 2);
  assert.ok(config.indexOf(addition) > config.indexOf("listen 443 ssl"));
  assert.equal(config.match(/location \^~ \/api\/payments\/ \{[^}]+\}[^}]+\}/)?.[0], canonical.match(/location \^~ \/api\/payments\/ \{[^}]+\}[^}]+\}/)?.[0]);
  assert.match(config, /proxy_ssl_verify on;/);
  assert.match(config, /proxy_ssl_trusted_certificate \/etc\/ssl\/certs\/ca-certificates\.crt;/);
  assert.doesNotMatch(addition, /proxy_ssl_verify|proxy_pass https|18090|proxy_cache_valid/);
});

test("server video route accepts only direct-child media reads, preserves LL-HLS query and bypasses caches", () => {
  const route = mediaLocation();
  assert.match(route, /limit_except GET \{ deny all; \}/);
  assert.match(route, /proxy_pass http:\/\/127\.0\.0\.1:8888\/station\/;/);
  assert.doesNotMatch(route, /\$args|\$is_args|rewrite|error_page|proxy_pass .*\$/);
  // Evaluate the actual generated nginx expression after its quoted-string
  // unescape, rather than testing an independent copy of the allowlist.
  const expression = route.match(/if \(\$uri !~ "([^"]+)"\)/)?.[1];
  assert.ok(expression);
  const mediaPath = new RegExp(expression.replaceAll("\\\\", "\\"));
  for (const value of ["index.m3u8", "f123_video_stream.m3u8", "init.mp4", "part_123.m4s", "seg123.mp4"]) assert.ok(mediaPath.test(`/live/station/${value}`));
  for (const value of ["", "../init.mp4", "child/index.m3u8", "index.html", "api", "a.mp4/", "a%2Emp4", "aXmp4"]) assert.ok(!mediaPath.test(`/live/station/${value}`));
  assert.ok(!mediaPath.test("/live/other/index.m3u8"));
  for (const directive of ["proxy_connect_timeout 1s;", "proxy_read_timeout 8s;", "proxy_send_timeout 5s;", "proxy_next_upstream off;", "proxy_intercept_errors off;", "proxy_method GET;", "proxy_cache off;", "proxy_buffering off;", "proxy_request_buffering off;", "proxy_pass_request_body off;"]) assert.ok(route.includes(directive));
  for (const header of ["Cache-Control", "CDN-Cache-Control", "Vercel-CDN-Cache-Control"]) {
    assert.ok(route.includes(`proxy_hide_header ${header};`));
    assert.ok(route.includes(`add_header ${header} no-store always;`));
  }
  for (const header of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Content-Security-Policy", "Permissions-Policy"]) assert.match(route, new RegExp(`add_header ${header}[^\\n]*always;`));
  assert.ok(route.includes(`proxy_set_header Authorization "Bearer ${hlsReadToken}";`));
  for (const header of ["Connection", "Upgrade", "X-Forwarded-For", "X-Real-IP", "Forwarded", "X-Forwarded-Host", "X-Forwarded-Port", "Origin", "Cookie", "Idempotency-Key", "Content-Length"]) assert.ok(route.includes(`proxy_set_header ${header} "";`));
  assert.ok(route.includes("proxy_set_header X-Forwarded-Proto https;"));
  assert.ok(route.includes("proxy_set_header Host 127.0.0.1;"));
});

test("systemd keeps credentials private and bounds an independently restarting remux process", async () => {
  const unit = await readFile(new URL("../ops/stream/chogcare-stream.service", import.meta.url), "utf8");
  for (const line of ["DynamicUser=yes", "LoadCredential=mediamtx.json:/etc/chogcare-stream/mediamtx.json", "LoadCredential=tls.crt:/etc/letsencrypt/live/chogcare-relay/fullchain.pem", "LoadCredential=tls.key:/etc/letsencrypt/live/chogcare-relay/privkey.pem", "ExecStart=/opt/chogcare-stream/mediamtx %d/mediamtx.json", "Environment=GOMEMLIMIT=112MiB", "MemoryHigh=128M", "MemoryMax=160M", "MemorySwapMax=0", "TasksMax=64", "Restart=on-failure", "RestartSec=5s", "StartLimitIntervalSec=0", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateDevices=yes", "UMask=0077", "StandardOutput=null", "StandardError=null"]) assert.ok(unit.split(/\r?\n/).includes(line), line);
  assert.doesNotMatch(unit, /ExecStart=.*(?:bash|sh |curl|ffmpeg)|ReadWritePaths=.*(?:letsencrypt|etc\/chogcare)|AmbientCapabilities=.+|CapabilityBoundingSet=.+|User=root/);
  const config = origin();
  assert.equal(config.rtmpServerCert, "/run/credentials/chogcare-stream.service/tls.crt");
  assert.equal(config.rtmpServerKey, "/run/credentials/chogcare-stream.service/tls.key");
});

test("certificate renewal refreshes only the matching stream credential snapshot", async () => {
  const hook = await readFile(new URL("../ops/stream/renew-stream-certificate.sh", import.meta.url), "utf8");
  assert.ok(hook.includes('case "${RENEWED_LINEAGE:-}" in\n  /etc/letsencrypt/live/chogcare-relay)'));
  assert.equal(hook.match(/\/usr\/bin\/systemctl[^\n]*/g)?.join(""), "/usr/bin/systemctl try-restart chogcare-stream.service");
  assert.doesNotMatch(hook, /payments|nginx|ssh|curl|eval|\$\(/);
});
