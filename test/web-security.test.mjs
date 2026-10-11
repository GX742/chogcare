import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { privateWebPath, contentSecurityPolicy } from "../server/web-boundary.ts";
import { createPaymentService } from "../server/payment-service.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createServer } from "vite";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

test("private URL guard covers encoded Windows paths, raw imports and backup files", () => {
  for (const path of [
    "/work/payments/custody/vault.json", "/WORK/payments/custody/vault.json?raw",
    "/@fs/C:/project/work/payments/preview.sqlite?import", "/%77ork/payments/vault.json",
    "/%2577ork/payments/vault.json", "/src/../work/payments/vault.json",
    "/work%5cpayments%5cvault.json", "/work./payments/vault.json", "/work%20/payments/vault.json",
    "/.env.local?raw", "/.git/config", "/anything.sqlite-wal", "/server/payment-service.mjs",
    "/work::$INDEX_ALLOCATION/payments/vault.json", "/invalid%00path", "/invalid%ZZ", "/.codex/config.toml", "/.aws/credentials", "/.ssh/id_rsa",
  ]) assert.equal(privateWebPath(path), true, path);
  for (const path of ["/", "/src/main.tsx", "/@vite/client", "/api/payments/config", "/assets/chog.png", "/node_modules/.vite/deps/react.js?v=123"]) assert.equal(privateWebPath(path), false, path);
});

test("Vite refuses private files before static serving and raw imports", async t => {
  // An isolated optimizer cache cannot invalidate the user's running dev site.
  const temporaryRoot = resolve(tmpdir());
  const cacheDir = await mkdtemp(join(temporaryRoot, "chogcare-vite-test-"));
  let vite;
  t.after(async () => {
    await vite?.close();
    assert.equal(dirname(resolve(cacheDir)), temporaryRoot);
    assert.ok(basename(cacheDir).startsWith("chogcare-vite-test-"));
    await rm(cacheDir, { recursive: true, force: true });
  });
  vite = await createServer({ cacheDir, server: { port: 0, strictPort: false, hmr: false }, logLevel: "silent" });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const path of ["/server/payment-service.mjs", "/server/payment-service.mjs?raw", "/%77ork/payments/custody/vault.json", "/work/payments/preview.sqlite", "/@fs/" + process.cwd().replaceAll("\\", "/") + "/work/payments/custody/vault.json?raw"]) {
    // HEAD only: never retrieve the user's actual encrypted backup or database.
    const response = await fetch(base + path, { method: "HEAD" });
    assert.equal(response.status, 403, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const policy = page.headers.get("content-security-policy");
  assert.match(policy, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.match(policy, /frame-ancestors 'none'/);
  const nonce = policy.match(/'nonce-([^']+)'/)[1];
  const html = await page.text();
  assert.ok(html.includes(`nonce="${nonce}"`), "Vite's own inline scripts must carry the CSP nonce");
  assert.match(html, /property="csp-nonce"/);
  assert.equal((await fetch(base + "/src/main.tsx")).status, 200);
  const rebound = await new Promise((resolve,reject)=>{
    const req=request(base,{headers:{Host:"attacker.example"}},res=>{res.resume();resolve(res.statusCode);});
    req.on("error",reject);req.end();
  });
  assert.equal(rebound,403);
});

test("production HTML policy excludes inline scripts, eval, arbitrary images and dev sockets", () => {
  const policy = contentSecurityPolicy();
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /style-src 'self';/);
  assert.match(policy, /connect-src 'self' https:\/\/chogcare-stream\.tail1f833b\.ts\.net http:\/\/127\.0\.0\.1:8080 http:\/\/localhost:8080;/);
  assert.match(policy, /frame-src https:\/\/player\.twitch\.tv https:\/\/stream\.chogcare\.com/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|nonce-|ws:|https:\*/);
  assert.match(policy, /form-action 'none'/);
  assert.throws(()=>contentSecurityPolicy("bad'nonce"));
});

test("live media is limited to the protected relay, local Owncast and MSE/worker blobs", () => {
  const deployed = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const vercelPolicy = deployed.headers.flatMap(rule => rule.headers).find(header => header.key === "Content-Security-Policy").value;
  for (const policy of [contentSecurityPolicy(), vercelPolicy]) {
    assert.match(policy, /(?:^|; )media-src blob: https:\/\/chogcare-stream\.tail1f833b\.ts\.net(?: http:\/\/127\.0\.0\.1:8080 http:\/\/localhost:8080)?;/);
    assert.match(policy, /(?:^|; )worker-src 'self' blob:;/);
    assert.match(policy, /(?:^|; )connect-src 'self' https:\/\/chogcare-stream\.tail1f833b\.ts\.net(?: http:\/\/127\.0\.0\.1:8080 http:\/\/localhost:8080)?;/);
    assert.match(policy, /(?:^|; )script-src 'self';/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:\*|connect-src[^;]*\*/);
  }
  assert.doesNotMatch(vercelPolicy, /127\.0\.0\.1|localhost|media-src[^;]*http:/);
});

test("payment API rejects rebinding, CSRF, extra fields, media tricks and rate-limit bypass", async t => {
  const store = openInvoiceStore(":memory:");
  const service = createPaymentService(store);
  service.listen(0, "127.0.0.1"); await once(service, "listening");
  t.after(async () => { await new Promise(resolve => service.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const origin = "http://127.0.0.1:4173";
  const body = { mode: "chog", amount: "300", holderAddress: "", initiativeId: "burundi" };
  const post = (headers = {}, payload = body) => fetch(base + "/api/payments/previews", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = request(base + "/api/payments/config", { headers: { Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await post({ Origin: "null" })).status, 403);
  assert.equal((await post({ Origin: "" })).status, 403);
  assert.equal((await post({ "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ "Content-Type": "application/jsonp" })).status, 415);
  assert.equal((await post({ "Content-Encoding": "gzip" })).status, 415);
  assert.equal((await post({}, { ...body, recipient: "attacker" })).status, 400);
  const good = await post();
  assert.equal(good.status, 201);
  assert.equal(good.headers.get("x-frame-options"), "DENY");
  for (let i = 0; i < 60; i++) await fetch(base + "/api/payments/config", { headers: { "X-Forwarded-For": `10.0.0.${i}` } });
  // Reading status no longer consumes the create budget shared by the proxy.
  assert.equal((await post()).status, 201);
  for (let i = 0; i < 8; i++) await post({ "X-Forwarded-For": `10.0.0.${i}` });
  assert.equal((await post()).status, 429);
});
