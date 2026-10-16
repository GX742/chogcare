import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("public broadcast proxy is loopback-only and exposes only HLS and payment routes", () => {
  const config = readFileSync(new URL("../ops/owncast/nginx-public.conf", import.meta.url), "utf8");
  assert.match(config, /listen 127\.0\.0\.1:8090;/);
  assert.equal([...config.matchAll(/\blisten\s/g)].length, 1);
  assert.deepEqual([...config.matchAll(/^\s*location\s+([^\{]+)\{/gm)].map(match => match[1].trim()), ["^~ /hls/", "^~ /api/payments/", "/"]);
  assert.match(config, /location \/ \{ return 404; \}/);
  assert.deepEqual([...config.matchAll(/proxy_pass\s+([^;]+);/g)].map(match => match[1]), ["http://127.0.0.1:8080", "http://127.0.0.1:4174"]);
  assert.doesNotMatch(config, /^\s*(?:root|alias|autoindex|auth_basic_user_file)\s/m);
  assert.match(config, /client_max_body_size 4k;/);
  assert.match(config, /limit_except GET \{ deny all; \}/);
  assert.match(config, /limit_except GET POST \{ deny all; \}/);
  const paymentRoute=config.slice(config.indexOf("location ^~ /api/payments/"),config.indexOf("location / {"));
  assert.match(paymentRoute,/proxy_set_header Host chogcare\.xyz;/);
  assert.doesNotMatch(paymentRoute,/proxy_set_header Host chogcare\.vercel\.app;/);
});

test("security headers cover rejected public paths without location inheritance gaps", () => {
  const config = readFileSync(new URL("../ops/owncast/nginx-public.conf", import.meta.url), "utf8");
  const serverHeaders = config.slice(0, config.indexOf("location ^~"));
  for (const header of ["X-Content-Type-Options nosniff", "Referrer-Policy no-referrer", "X-Frame-Options DENY", "Content-Security-Policy", "Permissions-Policy"]) {
    assert.match(serverHeaders, new RegExp(`add_header ${header}[^;\\n]*.*always;`));
  }
  assert.doesNotMatch(config.slice(config.indexOf("location ^~")), /\badd_header\s/);
  assert.match(serverHeaders, /default-src 'none'; frame-ancestors 'none'; base-uri 'none'/);
});
