import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPublicLeaderboard } from "../src/leaderboard-client.ts";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const signal = () => new AbortController().signal;
const row = { rank: 1, nickname: "GX", initiativeId: "solar-foundation", amount: "600", avatarImage: null, avatarName: null, status: "delivered" };

test("failed or malformed leaderboard requests never become a confirmed empty board", async () => {
  for (const payload of [null, {}, { entries: "missing" }, { entries: [{ amount: "forged" }] }]) {
    await assert.rejects(loadPublicLeaderboard(signal(), async () => new Response(JSON.stringify(payload))));
  }
  await assert.rejects(loadPublicLeaderboard(signal(), async () => new Response("{}", { status: 502 })));
  await assert.rejects(loadPublicLeaderboard(signal(), async () => { throw new Error("Offline"); }));
});

test("a verified empty response remains valid, and public rows discard wallet/private extras", async () => {
  assert.deepEqual(await loadPublicLeaderboard(signal(), async () => new Response('{"entries":[]}')), []);
  const calls = [];
  const result = await loadPublicLeaderboard(signal(), async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ entries: [{ ...row, wallet: "private", invoiceId: "private" }] }));
  });
  assert.deepEqual(result, [row]);
  assert.equal(calls[0][0], "/api/payments/leaderboard");
  assert.equal(calls[0][1].credentials, "same-origin");
  assert.equal(calls[0][1].method, undefined, "GET-only, never an invoice or support POST");
});

test("aborted leaderboard results cannot publish even when transport ignores cancellation", async () => {
  const controller = new AbortController();
  await assert.rejects(loadPublicLeaderboard(controller.signal, async () => {
    controller.abort();
    return new Response(JSON.stringify({ entries: [row] }));
  }));
});

test("leaderboard effects keep stale responses out and distinguish failure from empty", () => {
  const source = read("../src/Leaderboard.tsx");
  assert.match(source, /if \(!disposed\) \{\s*setEntries\(next\.entries\);\s*setPoolUnavailable/);
  assert.match(source, /disposed = true; clearTimeout\(timer\); controller.abort/);
  assert.match(source, /12(?:000|_000)/);
  assert.match(source, /!unavailable && <div className="leaderboard-empty"/);
  assert.match(source, /Retry leaderboard/);
});

test("site CSS references real loaded variable font families on desktop as well as mobile", () => {
  for (const file of ["styles.css", "landing.css", "checkout.css", "station-redesign.css"]) {
    assert.doesNotMatch(read("../src/" + file), /["'](?:Manrope|DM Sans)["']/);
  }
  assert.match(read("../src/styles.css"), /font-family: "DM Sans Variable"/);
});

test("player recovery stays local, accessible and free of native controls", () => {
  const source = read("../src/App.tsx");
  assert.match(read("../src/live-recovery.ts"), /mediaProblem\?\.name === "NotAllowedError"/);
  assert.match(source, /Play broadcast/);
  assert.match(source, /Retry broadcast/);
  assert.match(source, /loadMonitor.dispose\(\)/);
  assert.match(source, /removeEventListener\("pause", pausedPlayback\)/);
  assert.match(source, /controls=\{false\}/);
});

test("dialogs keep a close action visible while scrolling and block background scrolling", () => {
  assert.match(read("../src/support-dialog.css"), /support-tools\{position:sticky;top:0;height:0/);
  assert.match(read("../src/landing.css"), /lp-dialog-tools \{ position: sticky/);
  assert.match(read("../src/styles.css"), /html:has\(dialog\[open\]\) \{ overflow: hidden/);
});

test("changing a cause resets old readiness and paused checkout still offers support", () => {
  const source = read("../src/PaymentCheckout.tsx");
  assert.match(source, /setReady\(false\); setNftReady\(false\); setPoolHealthy\(false\)/);
  assert.match(source, /checkout-service-help/);
  assert.match(source, /configInitiative === props.initiativeId/);
  assert.match(source, /serviceAllowed=\{currentConfig && serviceAllowed\}/);
  const holder = read("../src/LiveNftCheckout.tsx");
  assert.match(holder, /!ready\?"Holder donations paused"/);
  assert.doesNotMatch(holder, /ready\?availableClaims:0/);
});
