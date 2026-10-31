import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderBootstrapNginx, renderRelayNginx, renderFunnelRelayNginx } from "../ops/relay/nginx-config.mjs";

// Public example input only. The integration test connects exclusively to
// random local ports; it never reaches this address or an ACME/RPC service.
const publicIp = "8.8.8.8";
const funnelHostname = "example-node.example-tailnet.ts.net";

test("relay renderer rejects private/special IPv4 and configuration injection", () => {
  for (const value of [undefined, null, 123, "", " 8.8.8.8", "8.8.8.8\n", "8.8.8.8/32", "8.8.8.8:443", "https://8.8.8.8", "example.com", "[::1]", "::ffff:8.8.8.8", "008.8.8.8", "0x08080808", "134744072", "8.8.8.256", "8.8.8.8; include /tmp/other;", "0.1.2.3", "10.20.30.40", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.254", "240.0.0.1", "255.255.255.255"]) {
    assert.throws(() => renderBootstrapNginx({ publicIp: value }));
    assert.throws(() => renderRelayNginx({ publicIp: value }));
    assert.throws(() => renderFunnelRelayNginx({ publicIp: value, funnelHostname }));
  }
  for (const value of ["1.1.1.1", publicIp, "100.63.255.254", "100.128.0.1", "172.15.255.254", "172.32.0.1"]) {
    assert.ok(renderRelayNginx({ publicIp: value }).includes(`server_name ${value};`));
  }
});

test("certificate paths accept only a bounded safe name", () => {
  for (const certificateName of [null, "", ".", "..", "../other", "/tmp/cert", "a/b", "A", "a.b", "bad_name", "-name", "name-", "a".repeat(65), "name\ninclude /tmp/other;"]) {
    assert.throws(() => renderRelayNginx({ publicIp, certificateName }));
    assert.throws(() => renderFunnelRelayNginx({ publicIp, certificateName, funnelHostname }));
  }
  assert.match(renderRelayNginx({ publicIp }), /ssl_certificate \/etc\/letsencrypt\/live\/chogcare-relay\/fullchain\.pem;/);
  assert.match(renderRelayNginx({ publicIp, certificateName: "relay-2" }), /ssl_certificate_key \/etc\/letsencrypt\/live\/relay-2\/privkey\.pem;/);
});

test("bootstrap exposes only an exact-host ACME token over plaintext HTTP", () => {
  const config = renderBootstrapNginx({ publicIp });
  assert.equal([...config.matchAll(/\blisten\s/g)].length, 1);
  assert.match(config, /listen 80 default_server;/);
  assert.match(config, /if \(\$chogcare_relay_http_host_ok = 0\) \{ return 404; \}/);
  assert.match(config, /root \/var\/lib\/chogcare-relay\/acme;/);
  assert.match(config, /disable_symlinks on;/);
  assert.match(config, /try_files \$uri =404;/);
  assert.match(config, /limit_except GET \{ deny all; \}/);
  assert.match(config, /location \/ \{ return 404; \}/);
  assert.doesNotMatch(config, /proxy_pass|ssl_certificate|return 30[1278]|\/hls\/|location.*\/api/);
});

test("TLS supports IP clients without SNI and proxies only the fixed tunnel", () => {
  const config = renderRelayNginx({ publicIp });
  assert.match(config, /listen 443 ssl default_server;/);
  assert.match(config, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.doesNotMatch(config, /ssl_reject_handshake|\bhttp2\b/);
  assert.equal([...config.matchAll(/\blisten\s/g)].length, 2);
  assert.deepEqual([...config.matchAll(/proxy_pass\s+([^;]+);/g)].map(match => match[1]), ["http://127.0.0.1:18090", "http://127.0.0.1:18090"]);
  const tls = config.slice(config.indexOf("listen 443 ssl"));
  assert.deepEqual([...tls.matchAll(/^\s*location\s+([^\{]+)\{/gm)].map(match => match[1].trim()), ["= /hls", "= /api/payments", "^~ /hls/", "^~ /api/payments/", "/"]);
  assert.match(tls, /location \^~ \/hls\/ \{\s*limit_except GET \{ deny all; \}/);
  assert.match(tls, /location \^~ \/api\/payments\/ \{\s*limit_except GET POST \{ deny all; \}/);
  assert.match(tls, /client_max_body_size 4k;/);
  assert.doesNotMatch(tls, /^\s*(?:root|alias|auth_basic|auth_basic_user_file)\s/m);
});

test("relay preserves checkout session headers without trusting proxy identity", () => {
  const config = renderRelayNginx({ publicIp });
  for (const [name, value] of [["Host", "chogcare.xyz"], ["Origin", "$http_origin"], ["Cookie", "$http_cookie"], ["Idempotency-Key", "$http_idempotency_key"], ["X-Forwarded-Proto", "https"]]) {
    assert.ok(config.includes(`proxy_set_header ${name} ${value};`));
  }
  for (const name of ["X-Forwarded-For", "X-Real-IP", "Forwarded", "X-Forwarded-Host", "X-Forwarded-Port", "Upgrade"]) {
    assert.ok(config.includes(`proxy_set_header ${name} "";`));
  }
  assert.doesNotMatch(config, /set_real_ip_from|real_ip_header|proxy_ssl_verify\s+off|Access-Control-Allow-Credentials/);
  assert.match(config, /proxy_ignore_headers X-Accel-Redirect;/);
  assert.match(config, /proxy_hide_header X-Accel-Redirect;/);
});

test("request privacy, inherited security headers and diskless proxying cover both servers", () => {
  const config = renderRelayNginx({ publicIp });
  assert.equal([...config.matchAll(/access_log off;/g)].length, 2);
  assert.equal([...config.matchAll(/error_log \/dev\/null emerg;/g)].length, 2);
  for (const directive of ["proxy_buffering off;", "proxy_request_buffering off;", "proxy_max_temp_file_size 0;", "proxy_cache off;", "client_body_in_file_only off;", "client_body_buffer_size 4k;"]) assert.ok(config.includes(directive));
  for (const server of config.split("server {").slice(1)) {
    const headerScope = server.slice(0, server.indexOf("location "));
    for (const header of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Content-Security-Policy", "Permissions-Policy"]) {
      assert.match(headerScope, new RegExp(`add_header ${header}[^\\n]*always;`));
    }
    assert.doesNotMatch(server.slice(server.indexOf("location ")), /\badd_header\s/);
  }
});

test("Funnel transport accepts only two bounded lowercase DNS labels under ts.net", () => {
  for (const value of [undefined, null, 123, "", "ts.net", "node.ts.net", "node.tailnet.other.ts.net", "node.tailnet.example.com", "Node.tailnet.ts.net", "node.Tailnet.ts.net", "node.tailnet.ts.NET", "node.tailnet.ts.net.", " node.tailnet.ts.net", "node.tailnet.ts.net\n", "node.tailnet.ts.net\r\n", "node.tailnet.ts.net\0", "https://node.tailnet.ts.net", "user@node.tailnet.ts.net", "node.tailnet.ts.net:443", "node.tailnet.ts.net/", "node.tailnet.ts.net?key=value", "node.tailnet.ts.net#fragment", "node..ts.net", "-node.tailnet.ts.net", "node-.tailnet.ts.net", "node.-tailnet.ts.net", "node.tailnet-.ts.net", "node_name.tailnet.ts.net", `${"a".repeat(64)}.tailnet.ts.net`, `node.${"a".repeat(64)}.ts.net`, "node.tailnet.ts.net; include /tmp/other;"]) {
    assert.throws(() => renderFunnelRelayNginx({ publicIp, funnelHostname: value }));
  }
  for (const value of [funnelHostname, "a.b.ts.net", `${"a".repeat(63)}.${"b".repeat(63)}.ts.net`]) {
    assert.ok(renderFunnelRelayNginx({ publicIp, funnelHostname: value }).includes(`server ${value}:443;`));
  }
});

test("Funnel transport verifies its fixed TLS peer and reuses HTTP/1.1 connections", () => {
  const config = renderFunnelRelayNginx({ publicIp, funnelHostname });
  assert.match(config, /^upstream chogcare_funnel_upstream \{\n    server example-node\.example-tailnet\.ts\.net:443;\n    keepalive 16;\n\}/);
  for (const directive of [`proxy_set_header Host ${funnelHostname};`, "proxy_ssl_server_name on;", `proxy_ssl_name ${funnelHostname};`, "proxy_ssl_verify on;", "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;", "proxy_ssl_verify_depth 3;", "proxy_http_version 1.1;", 'proxy_set_header Connection "";']) {
    assert.ok(config.includes(directive), directive);
  }
  assert.deepEqual([...config.matchAll(/proxy_pass\s+([^;]+);/g)].map(match => match[1]), ["https://chogcare_funnel_upstream", "https://chogcare_funnel_upstream"]);
  assert.deepEqual([...config.matchAll(/proxy_connect_timeout\s+([^;]+);/g)].map(match => match[1]), ["10s"]);
  assert.deepEqual([...renderRelayNginx({ publicIp }).matchAll(/proxy_connect_timeout\s+([^;]+);/g)].map(match => match[1]), ["3s"]);
  assert.doesNotMatch(config, /127\.0\.0\.1:18090|proxy_ssl_verify\s+off|\bresolver\s|proxy_pass\s+[^;]*\$|proxy_cache\s+(?!off;)/);
});

test("Funnel substitution preserves the entire canonical public boundary and default renderer", () => {
  for (const options of [{ publicIp }, { publicIp: "1.1.1.1", certificateName: "relay-2" }]) {
    const original = renderRelayNginx(options);
    const config = renderFunnelRelayNginx({ ...options, funnelHostname });
    const restored = config
      .replace(`upstream chogcare_funnel_upstream {\n    server ${funnelHostname}:443;\n    keepalive 16;\n}\n\n`, "")
      .replace(`    proxy_set_header Host ${funnelHostname};\n    proxy_ssl_server_name on;\n    proxy_ssl_name ${funnelHostname};\n    proxy_ssl_verify on;\n    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;\n    proxy_ssl_verify_depth 3;`, "    proxy_set_header Host chogcare.xyz;")
      .replaceAll("proxy_pass https://chogcare_funnel_upstream;", "proxy_pass http://127.0.0.1:18090;")
      .replace("    proxy_connect_timeout 10s;", "    proxy_connect_timeout 3s;");
    assert.equal(restored, original);
    assert.equal(renderRelayNginx(options), original);
    assert.doesNotMatch(original, /chogcare_funnel_upstream|proxy_ssl_/);
  }
});

// A real nginx process validates behavior, rather than treating regular
// expressions over the rendered source as proof of the public boundary.
const integrationPython = String.raw`
import http.client, http.server, json, os, pathlib, shutil, socket, ssl, subprocess, sys, tempfile, threading, time

fixture = json.load(sys.stdin)
if not shutil.which("nginx") or not shutil.which("openssl"):
    print(json.dumps({"skipped": True, "reason": "nginx/openssl unavailable"})); sys.exit(0)

def require(condition, category):
    if not condition: raise AssertionError(category)

def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0)); return listener.getsockname()[1]

with tempfile.TemporaryDirectory(prefix="chogcare-relay-test-") as directory:
    base = pathlib.Path(directory); base.chmod(0o755)
    acme = base / "acme"; challenge = acme / ".well-known" / "acme-challenge"
    challenge.mkdir(parents=True)
    for item in (acme, acme / ".well-known", challenge): item.chmod(0o755)
    (challenge / "fixture-token_1").write_text("fixture-challenge")
    (challenge / "fixture-token_1").chmod(0o644)
    (challenge / "linked-token").symlink_to(challenge / "fixture-token_1")
    certificate = base / "fixture.pem"; key = base / "fixture.key"
    issued = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=relay-test-only", "-addext", "subjectAltName=IP:" + fixture["publicIp"], "-keyout", str(key), "-out", str(certificate)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    require(issued.returncode == 0, "TEST_CERTIFICATE_FAILED")
    key.chmod(0o600)
    observed = []

    class Upstream(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args): pass
        def answer(self):
            count = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(count) if count else b""
            observed.append({"method": self.command, "path": self.path, "headers": dict(self.headers.items()), "body": body})
            media = self.path.startswith("/hls/")
            output = b"#EXTM3U\n#EXT-X-TARGETDURATION:3\n" if media else b'{"fixture":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl" if media else "application/json")
            self.send_header("Cache-Control", "public, max-age=60, immutable" if self.path.endswith(".ts") else "no-store")
            self.send_header("CDN-Cache-Control", "max-age=60" if self.path.endswith(".ts") else "no-store")
            self.send_header("Content-Length", str(len(output)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'")
            if media: self.send_header("Access-Control-Allow-Origin", "*")
            else: self.send_header("Set-Cookie", "fixture_session=fixture; Secure; HttpOnly; SameSite=Strict")
            if self.path == "/hls/redirect.m3u8": self.send_header("X-Accel-Redirect", "/admin/")
            self.end_headers()
            if self.command != "HEAD": self.wfile.write(output)
        do_GET = answer
        do_HEAD = answer
        do_POST = answer
        do_OPTIONS = answer
        do_PUT = answer
        do_DELETE = answer

    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    ports = [available_port(), available_port()]
    while ports[0] == ports[1]: ports[1] = available_port()
    context = ssl.create_default_context(cafile=str(certificate))
    process = None

    def configuration(name):
        rendered = fixture[name]
        rendered = rendered.replace("listen 80 default_server;", "listen 127.0.0.1:%d default_server;" % ports[0])
        rendered = rendered.replace("listen 443 ssl default_server;", "listen 127.0.0.1:%d ssl default_server;" % ports[1])
        rendered = rendered.replace("/var/lib/chogcare-relay/acme", str(acme))
        rendered = rendered.replace("/etc/letsencrypt/live/chogcare-relay/fullchain.pem", str(certificate))
        rendered = rendered.replace("/etc/letsencrypt/live/chogcare-relay/privkey.pem", str(key))
        rendered = rendered.replace("http://127.0.0.1:18090", "http://127.0.0.1:%d" % upstream.server_port)
        path = base / (name + ".conf")
        path.write_text("worker_processes 1;\npid " + str(base / "nginx.pid") + ";\nerror_log /dev/null emerg;\nevents { worker_connections 64; }\nhttp { access_log off; client_body_temp_path " + str(base / "request_temp") + "; proxy_temp_path " + str(base / "response_temp") + "; " + rendered + "}\n")
        return path

    def start(name):
        global process
        path = configuration(name)
        checked = subprocess.run(["nginx", "-t", "-p", str(base) + "/", "-c", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        require(checked.returncode == 0, name.upper() + "_NGINX_SYNTAX")
        process = subprocess.Popen(["nginx", "-p", str(base) + "/", "-c", str(path), "-g", "daemon off;"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", ports[0]), timeout=0.2): return
            except OSError: time.sleep(0.02)
        raise AssertionError("ISOLATED_NGINX_START_FAILED")

    def stop():
        global process
        if process is not None:
            process.terminate()
            try: process.wait(timeout=4)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=2)
            process = None

    def request(path, method="GET", secure=True, host=None, body=None, extra=None):
        port = ports[1 if secure else 0]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        if secure:
            # IP verification stays enabled. Python/OpenSSL omit DNS SNI for
            # an IP literal, reproducing the public Vercel-to-IP TLS client.
            connection.sock = context.wrap_socket(socket.create_connection(("127.0.0.1", port), timeout=3), server_hostname=fixture["publicIp"])
        headers = {"Host": fixture["publicIp"] if host is None else host}
        if extra: headers.update(extra)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = (response.status, response.getheaders(), response.read())
        connection.close(); return result

    def values(headers, name): return [value for key, value in headers if key.lower() == name.lower()]

    blocked_count = 0
    def blocked(path, method="GET", status=404, **options):
        global blocked_count
        blocked_count += 1
        before = len(observed); result = request(path, method, **options)
        expected = status if isinstance(status, tuple) else (status,)
        require(result[0] in expected, "REJECTED_REQUEST_STATUS_%d_HTTP_%d" % (blocked_count, result[0]))
        require(len(observed) == before, "REJECTED_REQUEST_REACHED_UPSTREAM")
        require(values(result[1], "X-Content-Type-Options") == ["nosniff"], "REJECTED_SECURITY_HEADER")

    try:
        start("bootstrap")
        require(request("/.well-known/acme-challenge/fixture-token_1", secure=False)[2] == b"fixture-challenge", "ACME_TOKEN_UNAVAILABLE")
        require(request("/.well-known/acme-challenge/fixture-token_1", method="HEAD", secure=False, host=fixture["publicIp"] + ":80")[0] == 200, "ACME_HEAD_UNAVAILABLE")
        for path in ["/", "/hls/mobile/stream.m3u8", "/api/payments/config", "/admin/", "/.well-known/acme-challenge/", "/.well-known/acme-challenge/fixture-token_1/extra", "/.well-known/acme-challenge/.hidden", "/.well-known/acme-challenge/../fixture-token_1", "/.well-known/acme-challenge/%66ixture-token_1"]:
            blocked(path, secure=False)
        blocked("/.well-known/acme-challenge/fixture-token_1", "POST", status=403, secure=False)
        blocked("/.well-known/acme-challenge/fixture-token_1", secure=False, host="unrelated.invalid")
        blocked("/.well-known/acme-challenge/linked-token", status=(403, 404), secure=False)
        stop()

        start("relay")
        for host in [fixture["publicIp"], fixture["publicIp"] + ":443"]:
            result = request("/hls/mobile/stream.m3u8", host=host)
            require(result[0] == 200 and result[2].startswith(b"#EXTM3U"), "TLS_IP_NO_SNI_OR_HOST_FAILED")
            require(values(result[1], "Content-Type") == ["application/vnd.apple.mpegurl"], "HLS_MIME_CHANGED")
            require(values(result[1], "Access-Control-Allow-Origin") == ["*"], "HLS_CORS_CHANGED")
            require(values(result[1], "Cache-Control") == ["no-store"], "PLAYLIST_CACHE_CHANGED")
            require(values(result[1], "X-Content-Type-Options") == ["nosniff"], "DUPLICATE_SECURITY_HEADER")
        require(request("/hls/mobile/stream.m3u8", method="HEAD")[2] == b"", "HLS_HEAD_FAILED")
        segment = request("/hls/mobile/stream-1234567890123456.ts")
        require(values(segment[1], "Cache-Control") == ["public, max-age=60, immutable"], "SEGMENT_CACHE_CHANGED")
        require(values(segment[1], "CDN-Cache-Control") == ["max-age=60"], "SEGMENT_CDN_CACHE_CHANGED")
        origin = "https://chogcare.xyz"
        result = request("/api/payments/fixture", method="POST", body=b'{"fixture":true}', extra={"Origin": origin, "Cookie": "fixture_session=fixture", "Idempotency-Key": "fixture-id", "Content-Type": "application/json", "X-Forwarded-For": "untrusted", "X-Real-IP": "untrusted", "Forwarded": "for=untrusted", "X-Forwarded-Host": "unrelated.invalid", "X-Forwarded-Port": "1"})
        require(result[0] == 200, "API_POST_FAILED")
        sent = {key.lower(): value for key, value in observed[-1]["headers"].items()}
        require(sent.get("host") == "chogcare.xyz" and sent.get("origin") == origin, "API_ORIGIN_CHANGED")
        require(sent.get("cookie") == "fixture_session=fixture" and sent.get("idempotency-key") == "fixture-id", "API_RECOVERY_HEADERS_CHANGED")
        require(all(name not in sent for name in ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-port"]), "CLIENT_PROXY_IDENTITY_FORWARDED")
        require(values(result[1], "Set-Cookie") == ["fixture_session=fixture; Secure; HttpOnly; SameSite=Strict"], "API_SESSION_RESPONSE_CHANGED")
        require(not values(result[1], "Access-Control-Allow-Origin"), "API_CORS_BROADENED")
        require(request("/api/payments/config", method="HEAD")[0] == 200, "API_HEAD_FAILED")
        for method in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]: blocked("/hls/mobile/stream.m3u8", method, status=403)
        for method in ["PUT", "DELETE", "PATCH", "OPTIONS"]: blocked("/api/payments/config", method, status=403)
        for path in ["/", "/admin/", "/api/admin/serverconfig", "/api/status", "/api/config", "/ws", "/hls", "/api/payments", "/hls-other/stream.m3u8", "/api/payments-other/config", "/.env", "/metrics", "/api/payments/../../admin/", "/hls/../api/admin/serverconfig", "/hls/%2e%2e/admin/", "/hls/%252e%252e/admin/", "/hls/%2fadmin/", "/hls/stream%5c..%5cadmin", "/hls//mobile/stream.m3u8", "/hls/./mobile/stream.m3u8", "/hls/stream" + chr(92) + "admin", "http://unrelated.invalid/hls/mobile/stream.m3u8"]:
            blocked(path)
        for host in ["unrelated.invalid", "127.0.0.1", fixture["publicIp"] + ":80", fixture["publicIp"] + ".", fixture["publicIp"] + ":0443", ""]:
            blocked("/hls/mobile/stream.m3u8", host=host, status=(400, 404))
        blocked("/api/payments/fixture", method="POST", body=b"x" * 4097, status=413)
        require(request("/hls/redirect.m3u8")[2].startswith(b"#EXTM3U"), "UPSTREAM_INTERNAL_REDIRECT_FOLLOWED")
        require(not values(request("/hls/redirect.m3u8")[1], "X-Accel-Redirect"), "UPSTREAM_INTERNAL_REDIRECT_EXPOSED")
        require(request("/hls/mobile/stream.m3u8?fixture=%2f%25")[0] == 200, "QUERY_MISTAKEN_FOR_PATH")
        blocked("/api/payments/config", secure=False)
        require(request("/.well-known/acme-challenge/fixture-token_1", secure=False)[0] == 200, "ACME_RENEWAL_UNAVAILABLE")
        require(all(not item.is_file() for folder in [base / "request_temp", base / "response_temp"] for item in folder.rglob("*")), "PROXY_PAYLOAD_WRITTEN_TO_DISK")
        print(json.dumps({"pass": True, "bootstrap": True, "strictTlsWithoutSni": True, "boundaries": True, "headers": True, "noPayloadFiles": True}))
    except AssertionError as failure:
        print(json.dumps({"pass": False, "category": str(failure)})); sys.exit(1)
    except Exception as failure:
        print(json.dumps({"pass": False, "category": "INTEGRATION_%s_BLOCKED_%d" % (type(failure).__name__, blocked_count)})); sys.exit(1)
    finally:
        stop(); upstream.shutdown(); upstream.server_close()
`;

test("isolated nginx enforces TLS, route, method, session, ACME and privacy boundaries", { timeout: 40_000 }, t => {
  const useWsl = process.platform === "win32" && process.env.CHOGCARE_RELAY_WSL_TEST === "1";
  if (process.platform === "win32" && !useWsl) return t.skip("Enable CHOGCARE_RELAY_WSL_TEST=1 for isolated WSL nginx integration.");
  const command = useWsl ? "wsl.exe" : "python3";
  const args = useWsl ? ["-d", "Ubuntu", "--", "python3", "-c", integrationPython] : ["-c", integrationPython];
  const child = spawnSync(command, args, {
    input: JSON.stringify({ publicIp, bootstrap: renderBootstrapNginx({ publicIp }), relay: renderRelayNginx({ publicIp }) }),
    encoding: "utf8", windowsHide: true, timeout: 35_000, maxBuffer: 1_048_576,
  });
  if (child.error?.code === "ENOENT") return t.skip("Python/nginx integration runtime unavailable.");
  let result;
  try { result = JSON.parse(child.stdout.trim()); } catch { assert.fail("Isolated nginx test returned no safe structured result."); }
  if (result.skipped) return t.skip(result.reason);
  assert.equal(child.status, 0, result.category ?? "Isolated nginx process failed.");
  assert.deepEqual(result, { pass: true, bootstrap: true, strictTlsWithoutSni: true, boundaries: true, headers: true, noPayloadFiles: true });
});
