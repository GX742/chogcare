import test from "node:test";
import assert from "node:assert/strict";
import { createStationLeaderboard } from "../scripts/station-leaderboard.mjs";

const endpoint = "http://127.0.0.1:4174/api/payments/leaderboard";
const avatar = name => `https://gateway.pinata.cloud/ipfs/${"a".repeat(46)}/${name}.png`;
const entry = (rank = 1, patch = {}) => ({ rank, nickname: `Donor ${rank}`, amount: "1800", initiativeId: "school-supplies", avatarImage: null, avatarName: null, status: "delivered", ...patch });
const response = entries => new Response(JSON.stringify({ entries }), { headers: { "Content-Type": "application/json" } });
const turn = () => new Promise(resolve => setImmediate(resolve));

test("station board reads only the fixed public GET, keeps five ranks and rounds exact selected totals without leaking capabilities", async t => {
  let requests = 0;
  const board = createStationLeaderboard({ fetcher: async (url, options) => {
    requests++;
    assert.equal(url, endpoint); assert.equal(options.method, undefined); assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return response(Array.from({ length: 8 }, (_, at) => entry(at + 1, { nickname: at === 0 ? "Élodie Иван" : `Donor ${at + 1}`, amount: at === 0 ? "1800.123456789012345678" : "300", invoiceId: "PRIVATE_INVOICE", sender: "PRIVATE_WALLET" })));
  } }); t.after(() => board.close());
  const cards = []; for (let at = 0; at < 6; at++) cards.push(await board.next());
  assert.deepEqual(cards.map(card => card.rank), [1, 2, 3, 4, 5, 1]);
  assert.equal(cards[0].nick, "Elodie Иван"); assert.equal(cards[0].amount, "1,800.12");
  assert.deepEqual(Object.keys(cards[0]).sort(), ["amount", "id", "image", "nick", "rank"]);
  assert.match(cards[0].id, /^[a-f0-9]{24}$/); assert.equal(cards[0].id, cards[5].id);
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE|invoice|wallet|sender|avatarImage|initiative/);
  assert.equal(requests, 1);
});

test("station board filters malformed ranks and avatars while preserving its public rank and safe fallback", async t => {
  let avatarReads = 0;
  const board = createStationLeaderboard({ fetcher: async () => response([
    entry(0), entry(21), entry(2, { amount: "NaN" }), entry(3, { nickname: "bad\nname" }),
    entry(4, { avatarImage: "http://127.0.0.1/private", nickname: "你好" }), entry(4),
    entry(5, { avatarImage: avatar("../private") }),
  ]), avatarLoader: async () => { avatarReads++; throw new Error("must not load an unsafe URL"); } });
  t.after(() => board.close());
  const first = await board.next(), second = await board.next();
  assert.equal(first.rank, 4); assert.equal(first.nick, "CHOG FRIEND"); assert.equal(first.image, null);
  assert.equal(second.rank, 5); assert.equal(second.image, null); assert.equal(avatarReads, 0);
});

test("board refresh and simultaneous next calls coalesce rather than race or skip a donor", async t => {
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const board = createStationLeaderboard({ fetcher: async () => { reads++; await gate; return response([entry(1), entry(2)]); } });
  t.after(() => board.close());
  const refresh = board.refresh(), first = board.next(), same = board.next();
  assert.equal(reads, 1); release(); await refresh;
  assert.deepEqual(await first, await same);
  assert.equal((await board.next()).rank, 2); assert.equal(reads, 1);
});

test("board refresh uses its last good snapshot through an outage for at most 120 seconds", async t => {
  let clock = 1000, available = true, reads = 0;
  const board = createStationLeaderboard({ now: () => clock, fetcher: async () => { reads++; return available ? response([entry()]) : new Response("offline", { status: 503 }); } });
  t.after(() => board.close());
  const first = await board.next(); available = false;
  clock += 29_999; assert.equal((await board.next()).id, first.id); assert.equal(reads, 1);
  clock++; assert.equal((await board.next()).id, first.id); assert.equal(reads, 2);
  clock = 120_999; assert.equal((await board.next()).id, first.id);
  clock++; assert.equal(await board.next(), null);
  available = true; clock += 30_000; assert.equal((await board.next()).id, first.id);
});

test("successful empty board clears previously shown donors immediately and invalid replies do not fabricate emptiness", async t => {
  let entries = [entry()], invalid = false;
  const board = createStationLeaderboard({ fetcher: async () => invalid ? response([{ rank: "bad" }]) : response(entries) });
  t.after(() => board.close());
  const first = await board.next(); invalid = true; await board.refresh();
  assert.equal((await board.next()).id, first.id);
  invalid = false; entries = []; await board.refresh(); assert.equal(await board.next(), null);
});

test("public JSON is bounded before and during streaming, regardless of a lying Content-Length", async () => {
  for (const declared of ["32769", "-1", "1"]) {
    let pulls = 0, cancelled = false;
    const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(16_384)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const board = createStationLeaderboard({ fetcher: async () => new Response(stream, { headers: { "Content-Length": declared } }) });
    try {
      assert.equal(await board.next(), null); assert.equal(cancelled, true);
      assert.ok(declared === "1" ? pulls === 3 : pulls === 0);
    } finally { board.close(); }
  }
});

test("the two-second JSON deadline includes an unresponsive fetch and a stalled body reader", async () => {
  const signals = [], boards = [
    createStationLeaderboard({ fetcher: async (_url, options) => { signals.push(options.signal); return new Promise(() => {}); } }),
    createStationLeaderboard({ fetcher: async (_url, options) => { signals.push(options.signal); return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 })); } }),
  ];
  const started = Date.now();
  try {
    assert.deepEqual(await Promise.all(boards.map(board => board.next())), [null, null]);
    assert.ok(Date.now() - started >= 1800); assert.ok(Date.now() - started < 5000);
    assert.ok(signals.every(signal => signal.aborted));
  } finally { boards.forEach(board => board.close()); }
});

test("avatars load lazily, share a bounded cache, return defensive pixel copies and participate in the stable content identity", async t => {
  let clock = 1000, loads = 0, pixel = 1;
  let url = avatar("1638"); const board = createStationLeaderboard({ now: () => clock,
    fetcher: async () => response([entry(1, { avatarImage: url }), entry(2, { avatarImage: url })]),
    avatarLoader: async requested => { loads++; assert.equal(requested, url); return Buffer.alloc(8192, pixel); },
  }); t.after(() => board.close());
  await board.refresh(); assert.equal(loads, 0);
  const first = await board.next(); first.image[0] = 99;
  assert.equal((await board.next()).image[0], 1); const again = await board.next();
  assert.equal(again.image[0], 1); assert.equal(again.id, first.id); assert.equal(loads, 1);
  clock += 30_000; pixel = 2;
  await board.next(); const cached = await board.next();
  assert.equal(cached.image[0], 1, "immutable IPFS images remain cached across board refreshes");
  assert.equal(cached.id, first.id); assert.equal(loads, 1);
  url = avatar("1639"); await board.refresh();
  const changed = await board.next();
  assert.equal(changed.rank, 1); assert.equal(changed.image[0], 2);
  assert.notEqual(changed.id, first.id); assert.equal(loads, 2);
});

test("an avatar failure or malformed pixel buffer selects the built-in coin without losing the donor", async () => {
  for (const loader of [async () => { throw new Error("gateway failed"); }, async () => Buffer.alloc(8191), async () => new Uint8Array(8192)]) {
    const board = createStationLeaderboard({ fetcher: async () => response([entry(1, { avatarImage: avatar("1638") })]), avatarLoader: loader });
    try { const card = await board.next(); assert.equal(card.nick, "Donor 1"); assert.equal(card.image, null); } finally { board.close(); }
  }
});

test("closing aborts network work, discards late results and ends pending avatar work without displaying a card", async () => {
  let release, signal;
  const board = createStationLeaderboard({ fetcher: async (_url, options) => { signal = options.signal; await new Promise(resolve => { release = resolve; }); return response([entry()]); } });
  const pending = board.next(); board.close(); board.close();
  assert.equal(await pending, null); assert.equal(signal.aborted, true); release(); await turn();
  assert.equal(await board.next(), null); await board.refresh();
  let entered = false, finish;
  const avatars = createStationLeaderboard({ fetcher: async () => response([entry(1, { avatarImage: avatar("1638") })]), avatarLoader: async () => { entered = true; await new Promise(resolve => { finish = resolve; }); return Buffer.alloc(8192); } });
  const card = avatars.next(); while (!entered) await turn();
  avatars.close(); assert.equal(await card, null); finish(); await turn(); assert.equal(await avatars.next(), null);
});

test("a donor removed during avatar decoding cannot return from an obsolete generation", async t => {
  let entries = [entry(1, { avatarImage: avatar("1638") })], entered = false, finish;
  const board = createStationLeaderboard({ fetcher: async () => response(entries), avatarLoader: async () => { entered = true; await new Promise(resolve => { finish = resolve; }); return Buffer.alloc(8192); } });
  t.after(() => board.close());
  const pending = board.next(); while (!entered) await turn();
  entries = []; await board.refresh(); finish(); assert.equal(await pending, null); assert.equal(await board.next(), null);
});
