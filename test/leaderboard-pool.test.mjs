import test from "node:test";
import assert from "node:assert/strict";
import { parseNftPoolImpact, presentPoolUsdc } from "../src/leaderboard-pool.ts";
import { loadPublicCareBoard, loadPublicLeaderboard } from "../src/leaderboard-client.ts";

test("pool totals use exact USDC units and pick no private response properties", () => {
  const source = { donatedUsdc: "2500000", donations: 4, wallet: "PRIVATE", txHash: "PRIVATE", rank: 1 };
  assert.deepEqual(parseNftPoolImpact(source), { donatedUsdc: "2500000", donations: 4 });
  assert.deepEqual(parseNftPoolImpact({ donatedUsdc: "0", donations: 0 }), { donatedUsdc: "0", donations: 0 });
  assert.equal(source.wallet, "PRIVATE");
  for (const [units, display] of [["0", "0.00"], ["500000", "0.50"], ["2500000", "2.50"], ["1000001", "1.000001"], ["1", "0.000001"], ["9007199254740993000001", "9,007,199,254,740,993.000001"]]) assert.equal(presentPoolUsdc(units), display);
});

test("unknown, contradictory or malformed pool totals are unavailable rather than zero", () => {
  for (const value of [undefined, null, [], {}, { donatedUsdc: "-1", donations: 1 }, { donatedUsdc: "1.00", donations: 1 }, { donatedUsdc: "1\n", donations: 1 }, { donatedUsdc: "01", donations: 1 }, { donatedUsdc: "1e6", donations: 1 }, { donatedUsdc: "9".repeat(79), donations: 1 }, { donatedUsdc: "0", donations: 1 }, { donatedUsdc: "1", donations: 0 }, { donatedUsdc: "1", donations: 1.5 }, { donatedUsdc: "1", donations: -1 }, { donatedUsdc: "1", donations: 1_000_001 }]) assert.equal(parseNftPoolImpact(value), null);
  for (const value of ["-1", "1e6", "1\n", "01"]) assert.throws(() => presentPoolUsdc(value), TypeError);
});

test("care board loads the unranked pool separately and preserves donor rankings", async () => {
  const entry = { rank: 1, nickname: "GX", initiativeId: "school-supplies", amount: "300", status: "delivered", avatarImage: null, avatarName: null };
  const calls = [];
  const fetcher = async (url, options) => { calls.push(url); assert.equal(options.method, undefined); return new Response(JSON.stringify({ entries: [entry], pool: { donatedUsdc: "2500000", donations: 4 } })); };
  const board = await loadPublicCareBoard(new AbortController().signal, fetcher);
  assert.deepEqual(board, { entries: [entry], pool: { donatedUsdc: "2500000", donations: 4 } });
  assert.deepEqual(await loadPublicLeaderboard(new AbortController().signal, fetcher), [entry]);
  assert.deepEqual(calls, ["/api/payments/leaderboard", "/api/payments/leaderboard"]);
});

test("old workers and failed pool totals retain the donor board without inventing a total", async () => {
  for (const payload of [{ entries: [] }, { entries: [], pool: null }, { entries: [], pool: { donatedUsdc: "broken", donations: 0 } }]) {
    assert.deepEqual(await loadPublicCareBoard(new AbortController().signal, async () => new Response(JSON.stringify(payload))), { entries: [], pool: null });
  }
  await assert.rejects(loadPublicCareBoard(new AbortController().signal, async () => new Response("{}", { status: 503 })));
});
