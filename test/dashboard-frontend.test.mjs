import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicBroadcastOrigin } from "../src/broadcast-source.ts";
import { dashboardChogAmount, formatEstimateUsd, observeBroadcast, parseBridgeEstimate, parseDashboardSnapshot, readBroadcastManifest } from "../src/ops-dashboard-model.ts";
import { estimateUnavailableMessage, readBoundedBroadcastBody, runBridgeEstimate } from "../src/ops-dashboard-requests.ts";

const now = 1_791_700_000_000;
const stream = `${publicBroadcastOrigin}/hls/stream.m3u8`;
const snapshot = changes => ({ checkedAt: now, payments: { state: "ready", nftState: "paused", availableClaims: 2, maxDailyClaims: 3, subsidyUsdc: "1.00", dailyPoolLimitUsdc: "3.00" }, impact: { chogDonated: "12345678901234567890.123456789012345678", donations: 12 }, station: { state: "unknown" }, broadcast: { state: "unknown" }, ...changes });
const quote = changes => ({ checkedAt: now, expiresAt: now + 30_000, amountChog: "300", poolContributionChog: "30", totalChog: "330", conversionMinimumUsdc: "0.90123", expectedCharityUsd: "0.872345", minimumCharityUsd: "0.854321", bridgeFeeUsd: "0.028885", bridgeFeePercent: "3.2", estimatedSeconds: 45, notice: "Estimate only; source gas and slippage are separate.", ...changes });
const media = (sequence = "12", time = null, ended = false) => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${time === null ? "" : `#EXT-X-PROGRAM-DATE-TIME:${new Date(time).toISOString()}\n`}#EXTINF:1.0,\nsegment.ts\n${ended ? "#EXT-X-ENDLIST" : ""}`;

test("public dashboard projects known fields and never retains wallet/admin extras", () => {
  const value = snapshot({ adminPassword: "must-not-display", walletAddress: "0xprivate", invoiceId: "a".repeat(64) });
  value.payments.custodyAddress = "private"; value.impact.seed = "private";
  const result = parseDashboardSnapshot(value);
  assert.deepEqual(Object.keys(result).sort(), ["broadcast", "checkedAt", "impact", "payments", "station"]);
  assert.equal(result.payments.custodyAddress, undefined);
  assert.equal(result.impact.seed, undefined);
  assert.equal(result.impact.chogDonated, value.impact.chogDonated);
});
test("unverified totals and availability remain unknown, not zero", () => {
  const value = snapshot({ impact: null }); value.payments.availableClaims = null;
  assert.equal(parseDashboardSnapshot(value).impact, null);
  assert.equal(parseDashboardSnapshot(value).payments.availableClaims, null);
  assert.equal(parseDashboardSnapshot(snapshot({ impact: { chogDonated: "0", donations: 0 } })).impact.chogDonated, "0");
});
test("dashboard rejects malformed states, changed pool policy and invalid amounts", () => {
  for (const property of ["state", "nftState"]) { const value = snapshot(); value.payments[property] = "healthy"; assert.equal(parseDashboardSnapshot(value), null); }
  for (const [key, value] of [["maxDailyClaims", 20], ["subsidyUsdc", "0.50"], ["dailyPoolLimitUsdc", "10.00"], ["availableClaims", 4], ["availableClaims", -1]]) {
    const bad = snapshot(); bad.payments[key] = value; assert.equal(parseDashboardSnapshot(bad), null);
  }
  for (const chogDonated of ["NaN", "1e9", "-1", "1\n", "9".repeat(79), "0.0000000000000000001"]) assert.equal(parseDashboardSnapshot(snapshot({ impact: { chogDonated, donations: 1 } })), null);
  assert.equal(parseDashboardSnapshot(snapshot({ checkedAt: "2026-10-11" })), null);
  assert.equal(parseDashboardSnapshot(snapshot({ station: { state: "ready" } })), null);
  const locked = snapshot(); locked.payments.integrityLocked = true; assert.equal(parseDashboardSnapshot(locked), null);
});
test("dashboard CHOG and USD formatting never rounds large integers or fractions upward", () => {
  assert.equal(dashboardChogAmount("12345678901234567890.123456789012345678"), "12,345,678,901,234,567,890.1234…");
  assert.equal(dashboardChogAmount("0"), "0");
  assert.equal(formatEstimateUsd("0.872345"), "$0.872345");
  assert.equal(formatEstimateUsd("1000.000000"), "$1,000.00");
  assert.equal(formatEstimateUsd("0.000001"), "$0.000001");
  assert.throws(() => formatEstimateUsd("1\n"));
});
test("bridge estimate accepts backend decimal conversion USD and projects no identities", () => {
  const result = parseBridgeEstimate(quote({ payer: "0xprivate", invoiceId: "a".repeat(64) }), "300", now);
  assert.equal(result.conversionMinimumUsdc, "0.90123");
  assert.equal(result.payer, undefined); assert.equal(result.invoiceId, undefined);
  assert.equal(result.expectedCharityUsd, "0.872345");
});
test("bridge estimates must match the selected amount, exact allocation and live expiry", () => {
  assert.equal(parseBridgeEstimate(quote(), "3000", now), null);
  for (const change of [{ poolContributionChog: "0" }, { totalChog: "300" }, { expiresAt: now }, { checkedAt: now + 30_001 }, { conversionMinimumUsdc: "0" }, { expectedCharityUsd: "0.1" }, { bridgeFeePercent: "100.01" }, { bridgeFeeUsd: "-1" }, { expectedCharityUsd: "1e10" }, { estimatedSeconds: 0 }, { notice: "unsafe\nmessage" }]) assert.equal(parseBridgeEstimate(quote(change), "300", now), null);
  const big = quote({ amountChog: "30000", poolContributionChog: "3000", totalChog: "33000" });
  assert.equal(parseBridgeEstimate(big, "30000", now).totalChog, "33000");
});
test("master playlist variants can only choose the pinned public HLS relay", () => {
  assert.equal(readBroadcastManifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n0/stream.m3u8", stream).variant, `${publicBroadcastOrigin}/hls/0/stream.m3u8`);
  for (const path of ["https://evil.example/hls/stream.m3u8", "http://127.0.0.1:8080/hls/stream.m3u8", "/api/admin/serverconfig", "/hls/stream.m3u8?token=secret", "../admin/stream.m3u8", "https://name:password@chogcare-stream.tail1f833b.ts.net/hls/stream.m3u8"]) assert.equal(readBroadcastManifest(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${path}`, stream).variant, null);
  assert.equal(readBroadcastManifest("#EXTM3U" + "x".repeat(32768), stream), null);
  assert.equal(readBroadcastManifest("not a playlist", stream), null);
});
test("a reachable master or frozen media playlist is not reported live", () => {
  const master = readBroadcastManifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n0/stream.m3u8", stream);
  assert.equal(observeBroadcast(null, master, now).live, false);
  const first = observeBroadcast(null, readBroadcastManifest(media(), stream), now);
  assert.equal(first.live, false);
  const second = observeBroadcast(first.observation, readBroadcastManifest(media("13"), stream), now + 15_000);
  assert.equal(second.live, true);
  assert.equal(observeBroadcast(second.observation, readBroadcastManifest(media("13"), stream), now + 60_001).live, false);
});
test("fresh media timestamps prove activity but stale, future and ended streams do not", () => {
  assert.equal(observeBroadcast(null, readBroadcastManifest(media("1", now - 1000), stream), now).live, true);
  for (const time of [now - 46_000, now + 31_000]) assert.equal(observeBroadcast(null, readBroadcastManifest(media("1", time), stream), now).live, false);
  assert.equal(observeBroadcast(null, readBroadcastManifest(media("1", now, true), stream), now).live, false);
});
test("dashboard remains a GET-only, independent read-only route with real artwork", () => {
  const source = readFileSync(new URL("../src/OpsDashboard.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("/chogcare-sunset.png")); assert.ok(source.includes("/chog-donation-coin.png"));
  const requests = readFileSync(new URL("../src/ops-dashboard-requests.ts", import.meta.url), "utf8");
  assert.ok(source.includes("/api/payments/dashboard")); assert.ok(requests.includes("/api/payments/bridge-estimate?"));
  assert.ok(!source.includes('method: "POST"')); assert.ok(!source.includes("/api/admin")); assert.ok(!source.includes("createPaymentRequest"));
  assert.ok(!requests.includes('method: "POST"')); assert.ok(!source.includes("response.text()"));
  assert.ok(source.includes("Read-only dashboard. No admin access."));
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(main.includes('=== "/dashboard"')); assert.ok(main.includes('React.lazy(() => import("./OpsDashboard"))'));
  const css = readFileSync(new URL("../src/ops-dashboard.css", import.meta.url), "utf8");
  assert.ok(css.includes("prefers-reduced-motion")); assert.ok(!source.includes("style={{"));
});
test("a mocked estimate timeout shows a safe error and re-enables the button", async () => {
  const lifetime = new AbortController(), timeout = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, timeout.signal]);
  let busy = true, error = "", result = null;
  const calls = [];
  const http = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/config")) return new Response("{}");
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      queueMicrotask(() => timeout.abort(new DOMException("Private timeout diagnostics", "TimeoutError")));
    });
  };
  await runBridgeEstimate({ amount: "300", initiativeId: "school-supplies", signal, isCurrent: () => true, onResult: value => { result = value; }, onError: value => { error = value; }, onSettled: () => { busy = false; } }, http, () => now);
  assert.equal(signal.aborted, true); assert.equal(lifetime.signal.aborted, false);
  assert.equal(busy, false); assert.equal(result, null); assert.equal(error, estimateUnavailableMessage);
  assert.equal(calls.length, 2); assert.ok(calls.every(url => !url.includes("/invoices")));
});
test("unmounted or superseded estimate requests never update frontend state", async () => {
  const controller = new AbortController();
  let current = true, updates = 0;
  const http = async (_url, options) => { current = false; controller.abort(); options.signal.throwIfAborted(); return new Response("{}"); };
  await runBridgeEstimate({ amount: "300", initiativeId: "school-supplies", signal: controller.signal, isCurrent: () => current, onResult: () => updates++, onError: () => updates++, onSettled: () => updates++ }, http, () => now);
  assert.equal(updates, 0);
});
test("successful and rejected estimates both settle; bootstrap failure sends no quote", async () => {
  let settled = 0, result = null, error = "";
  const task = { amount: "300", initiativeId: "school-supplies", signal: new AbortController().signal, isCurrent: () => true, onResult: value => { result = value; }, onError: value => { error = value; }, onSettled: () => settled++ };
  await runBridgeEstimate(task, async url => new Response(JSON.stringify(url.endsWith("/config") ? {} : quote())), () => now);
  assert.equal(result.amountChog, "300"); assert.equal(settled, 1); assert.equal(error, "");
  const calls = [];
  await runBridgeEstimate(task, async url => { calls.push(url); return new Response("secret diagnostics", { status: 503 }); }, () => now);
  assert.equal(settled, 2); assert.equal(error, estimateUnavailableMessage); assert.deepEqual(calls, ["/api/payments/config"]);
});
test("broadcast body is bounded before decode, including undeclared chunked responses", async () => {
  assert.equal(await readBoundedBroadcastBody(new Response("#EXTM3U\n")), "#EXTM3U\n");
  assert.equal((await readBoundedBroadcastBody(new Response("a".repeat(65536)))).length, 65536);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(30000)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBroadcastBody(new Response(body)), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedBroadcastBody(new Response("short", { headers: { "content-length": "65537" } })), /too large/);
  await assert.rejects(readBoundedBroadcastBody(new Response(new Uint8Array([0xff]))), /encoded data/);
});
test("dashboard typography uses the actual bundled variable font family names", () => {
  const css = readFileSync(new URL("../src/ops-dashboard.css", import.meta.url), "utf8");
  const body = css.match(/\.ops-dashboard\{([^}]+)\}/)?.[1];
  assert.ok(body.includes('font-family:"DM Sans Variable",sans-serif'));
  assert.ok(css.includes('.ops-dashboard h1,.ops-dashboard h2{font-family:"Manrope Variable",sans-serif}'));
  const admin = readFileSync(new URL("../src/admin/admin.css", import.meta.url), "utf8");
  assert.ok(admin.match(/:root\{[^}]*font-family:'Manrope Variable',sans-serif/));
});
