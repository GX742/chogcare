import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("public broadcast proxy is loopback-only and exposes only HLS and payment routes", () => {
  const config = readFileSync(new URL("../ops/owncast/nginx-public.conf", import.meta.url), "utf8");
  const service = readFileSync(new URL("../ops/owncast/owncast.service", import.meta.url), "utf8");
  assert.match(service, /^ExecStart=\/opt\/owncast\/owncast -webserverip 127\.0\.0\.1 -webserverport 8082$/m);
  assert.match(config, /listen 127\.0\.0\.1:8090;/);
  assert.equal([...config.matchAll(/\blisten\s/g)].length, 1);
  assert.deepEqual([...config.matchAll(/^\s*location\s+([^\{]+)\{/gm)].map(match => match[1].trim()), ["= /hls/stream.m3u8", "= /hls/mobile/preview.jpg", "^~ /hls/mobile/", "^~ /hls/", "^~ /api/payments/", "/"]);
  assert.match(config, /location \/ \{ return 404; \}/);
  assert.deepEqual([...config.matchAll(/proxy_pass\s+([^;]+);/g)].map(match => match[1]), ["http://127.0.0.1:8082", "http://127.0.0.1:4174"]);
  assert.doesNotMatch(config, /^\s*(?:root|auth_basic_user_file)\s/m);
  assert.deepEqual([...config.matchAll(/^\s*alias\s+([^;]+);/gm)].map(match=>match[1]), ["/var/lib/chogcare-preview/preview.jpg", "/var/lib/chogcare-mobile/"]);
  const mobile=config.slice(config.indexOf("location ^~ /hls/mobile/"),config.indexOf("location ^~ /hls/ {"));
  assert.match(mobile,/autoindex off;/);assert.match(mobile,/disable_symlinks on;/);
  assert.ok(mobile.includes(String.raw`if ($uri !~ "^/hls/mobile/(stream\\.m3u8|stream-[0-9]+\\.ts)$") { return 404; }`));
  assert.match(config, /client_max_body_size 4k;/);
  assert.match(config, /limit_except GET \{ deny all; \}/);
  assert.match(config, /limit_except GET POST \{ deny all; \}/);
  const paymentRoute=config.slice(config.indexOf("location ^~ /api/payments/"),config.indexOf("location / {"));
  assert.match(paymentRoute,/proxy_set_header Host chogcare\.xyz;/);
  assert.doesNotMatch(paymentRoute,/proxy_set_header Host chogcare\.vercel\.app;/);
});

test("public master advertises only the bounded mobile rendition and rejects non-read methods", () => {
  const config = readFileSync(new URL("../ops/owncast/nginx-public.conf", import.meta.url), "utf8");
  const master = config.slice(config.indexOf("location = /hls/stream.m3u8"), config.indexOf("location = /hls/mobile/preview.jpg"));
  const body = master.match(/return 200 '([^']+)';/)[1].replaceAll("\\n", "\n");
  assert.deepEqual(body.trim().split("\n"), [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-STREAM-INF:BANDWIDTH=280000,AVERAGE-BANDWIDTH=200000,RESOLUTION=360x640,FRAME-RATE=15.000,CODECS="avc1.4d401f"',
    "mobile/stream.m3u8",
  ]);
  assert.match(master, /if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 403; \}/);
  assert.ok(master.indexOf("return 403;") < master.indexOf("return 200 "));
  assert.match(master, /default_type "";/);
  assert.doesNotMatch(master, /proxy_pass|sub_filter|\badd_header\s/);
});

test("mobile keyframes align with six-second segments and preserve a 72-second recovery window", () => {
  const unit = readFileSync(new URL("../ops/owncast/chogcare-mobile.service", import.meta.url), "utf8");
  const command = unit.match(/^ExecStart=(.*)$/m)[1];
  const option = name => Number(command.match(new RegExp(`(?:^| )-${name} ([0-9]+)(?: |$)`))[1]);
  const fps = Number(command.match(/-x264-params fps=([0-9]+)\/1(?: |$)/)[1]);
  const segmentSeconds = option("hls_time");
  assert.equal(fps, 15);
  assert.equal(segmentSeconds, 6);
  assert.equal(option("g") / fps, segmentSeconds);
  assert.equal(option("keyint_min"), option("g"));
  assert.equal(option("sc_threshold"), 0);
  assert.equal(option("hls_list_size") * segmentSeconds, 72);
  assert.match(command, /framestep=2 /);
  assert.match(command, /-fps_mode vfr /);
});

test("security headers cover rejected public paths without location inheritance gaps", () => {
  const config = readFileSync(new URL("../ops/owncast/nginx-public.conf", import.meta.url), "utf8");
  const serverHeaders = config.slice(0, config.indexOf("location ="));
  for (const header of ["X-Content-Type-Options nosniff", "Referrer-Policy no-referrer", "X-Frame-Options DENY", "Content-Security-Policy", "Permissions-Policy"]) {
    assert.match(serverHeaders, new RegExp(`add_header ${header}[^;\\n]*.*always;`));
  }
  assert.doesNotMatch(config.slice(config.indexOf("location =")), /\badd_header\s/);
  assert.match(serverHeaders, /default-src 'none'; frame-ancestors 'none'; base-uri 'none'/);
});

test("native HLS receives explicit playlist and transport-stream MIME types without duplicate upstream headers",()=>{
  const config=readFileSync(new URL("../ops/owncast/nginx-public.conf",import.meta.url),"utf8");
  assert.match(config,/map \$uri \$chogcare_hls_content_type/);
  assert.ok(config.includes("~^/hls/.*\\.m3u8$ application/vnd.apple.mpegurl;"));
  assert.ok(config.includes("~^/hls/.*\\.ts$ video/mp2t;"));
  assert.match(config,/add_header Content-Type \$chogcare_hls_content_type always;/);
  const hls=config.slice(config.indexOf("location ^~ /hls/"),config.indexOf("location ^~ /api/payments/"));
  assert.match(hls,/proxy_hide_header Content-Type;/);assert.match(hls,/default_type "";/);
  assert.doesNotMatch(config.slice(config.indexOf("location ^~")),/\badd_header\s/);
});

test("derived video keeps waiting for an offline source without a permanent start-limit failure", () => {
  for (const name of ["chogcare-mobile", "chogcare-preview"]) {
    const unit = readFileSync(new URL(`../ops/owncast/${name}.service`, import.meta.url), "utf8");
    assert.match(unit.split("[Service]")[0], /^StartLimitIntervalSec=0$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^RestartSec=5$/m);
    assert.match(unit, /^User=owncast$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
  }
});
