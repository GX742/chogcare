import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePublicImpact, loadPublicImpact } from "../src/leaderboard-impact.ts";

const now = 1792162898029;
const rate = { referenceChog: "300", estimatedUsdMicros: "487917", quotedAt: now };
const dashboard = { impact: { chogDonated: "3600", donations: 12 } };

test("impact uses all completed donations rather than the public top 20", () => {
  assert.deepEqual(parsePublicImpact(dashboard, rate, now), { chogDonated: "3600", donations: 12, estimatedUsd: "$5.86" });
  assert.deepEqual(parsePublicImpact({ impact: { chogDonated: "0", donations: 0 } }, rate, now), { chogDonated: "0", donations: 0, estimatedUsd: "$0.00" });
});
test("USD conversion preserves large exact quantities without floating point", () => {
  const value = parsePublicImpact({ impact: { chogDonated: "9007199254740993", donations: 12 } }, { ...rate, estimatedUsdMicros: "300000000" }, now);
  assert.equal(value.estimatedUsd, "$9,007,199,254,740,993.00");
  assert.equal(parsePublicImpact({ impact: { chogDonated: "0.000000000000000001", donations: 1 } }, rate, now).estimatedUsd, "$0.00");
});
test("missing, stale or invalid quotes never fabricate a dollar amount", () => {
  for (const quote of [null, {}, { ...rate, quotedAt: now - 120001 }, { ...rate, quotedAt: now + 60001 }, { ...rate, referenceChog: "1" }, { ...rate, estimatedUsdMicros: "NaN" }, { ...rate, estimatedUsdMicros: "12\n" }]) {
    const result = parsePublicImpact(dashboard, quote, now);
    assert.equal(result.chogDonated, "3600"); assert.equal(result.estimatedUsd, null);
  }
});
test("unavailable or malformed totals are not substituted with zero", () => {
  for (const data of [null, {}, { impact: null }, { impact: { chogDonated: "NaN", donations: 1 } }, { impact: { chogDonated: "300\n", donations: 1 } }, { impact: { chogDonated: "300", donations: -1 } }]) assert.throws(() => parsePublicImpact(data, rate, now));
});
test("impact loader only reads existing public endpoints and keeps total if quote fails", async () => {
  const calls = [];
  const loaded = await loadPublicImpact(new AbortController().signal, async (url, options) => {
    calls.push(url); assert.equal(options.method, undefined);
    return url.endsWith("dashboard") ? new Response(JSON.stringify(dashboard)) : new Response("Unavailable", { status: 503 });
  });
  assert.deepEqual(calls, ["/api/payments/dashboard", "/api/payments/chog-rate"]);
  assert.equal(loaded.chogDonated, "3600"); assert.equal(loaded.estimatedUsd, null);
});
test("care board appears once below the initiative block", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/<Leaderboard\s*\//g) ?? []).length, 1);
  assert.ok(app.indexOf("<Leaderboard") > app.indexOf("<GivingExplainer"));
  assert.ok(app.indexOf("<Leaderboard") > app.indexOf('id={`cause-status-${item.id}`}'));
  assert.ok(app.indexOf("<Leaderboard") < app.indexOf('<section id="station"'));
});
