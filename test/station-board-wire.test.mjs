import test from "node:test";
import assert from "node:assert/strict";
import { createStationBoardTransport, validStationBoardAck } from "../scripts/station-board-wire.mjs";

const id = value => value.toString(16).padStart(24, "0");
const card = (changes = {}) => ({ id: id(1), nick: "GX", amount: "1,800", rank: 2, image: null, ...changes });
const ack = (status, offset, identity = id(1)) => ({ v: 1, type: "boardack", id: identity, status, offset: String(offset) });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture({ automatic = false, immediate = false, onWrite = () => {} } = {}) {
  let clock = 1000, nextTimer = 0, allowed = true, image = false;
  const lines = [], timers = new Map();
  const transport = createStationBoardTransport({
    write(line) {
      lines.push(line); const command = JSON.parse(line); onWrite(command, line);
      if (command.type === "board") image = command.image;
      if (automatic) {
        const message = command.type === "board" ? ack("ready", 0, command.id) :
          command.type === "pixels" ? ack("chunk", Number(command.offset) + 64, command.id) : ack("shown", image ? 4096 : 0, command.id);
        if (immediate) transport.receive(message); else queueMicrotask(() => transport.receive(message));
      }
    },
    canSend: () => allowed, now: () => clock,
    setTimer(callback, delay) { assert.equal(delay, 1200); const handle = ++nextTimer; timers.set(handle, { at: clock + delay, callback }); return handle; },
    clearTimer(handle) { timers.delete(handle); },
  });
  return {
    transport, lines, timers,
    commands: () => lines.map(line => JSON.parse(line)),
    allow(value) { allowed = value; },
    async advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > target) break;
        clock = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      clock = target; await flush();
    },
  };
}

test("board ACK schema accepts only its channel, canonical bounded offsets and exact keys", () => {
  for (const message of [ack("ready", 0), ack("chunk", 64), ack("chunk", 4096), ack("shown", 0), ack("shown", 4096)]) assert.equal(validStationBoardAck(message), true);
  for (const message of [null, [], {}, { ...ack("ready", 0), extra: true }, { ...ack("ready", 0), v: "1" },
    { ...ack("ready", 0), type: "ack" }, { ...ack("ready", 0), id: "A".repeat(24) },
    { ...ack("ready", 0), id: `${id(1)}\n` }, { ...ack("chunk", 64), offset: 64 },
    { ...ack("chunk", 64), offset: "064" }, { ...ack("chunk", 64), offset: "64\n" },
    ack("ready", 64), ack("chunk", 0), ack("chunk", 63), ack("chunk", 4097), ack("chunk", 4160), ack("shown", 64),
    ack("accepted", 0), ack("done", 0), { v: 1, type: "pong" }]) assert.equal(validStationBoardAck(message), false, JSON.stringify(message));
});

test("all 4096 RGB565 pixels travel in 64 acknowledged chunks followed by one commit, with immutable bytes and bounded lines", async () => {
  const f = fixture({ automatic: true }), image = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 256)), expected = Buffer.from(image);
  f.transport.setSupported(true);
  const result = f.transport.show(card({ image, nick: "Гость GX", amount: "3,000.25", rank: 20 }));
  image.fill(0); assert.equal(f.transport.busy, true);
  assert.equal(await result, true); assert.equal(f.transport.busy, false);
  const commands = f.commands();
  assert.equal(commands.length, 66);
  assert.deepEqual(commands[0], { v: 1, type: "board", id: id(1), nick: "Гость GX", amount: "3,000.25", rank: "20", image: true });
  const chunks = commands.slice(1, -1); assert.equal(chunks.length, 64);
  for (const [index, command] of chunks.entries()) {
    assert.deepEqual(Object.keys(command), ["v", "type", "id", "offset", "data"]);
    assert.equal(command.type, "pixels"); assert.equal(command.id, id(1)); assert.equal(command.offset, String(index * 64));
    assert.match(command.data, /^[a-f0-9]{256}$/);
  }
  assert.deepEqual(Buffer.concat(chunks.map(command => Buffer.from(command.data, "hex"))), expected);
  assert.deepEqual(commands.at(-1), { v: 1, type: "boardshow", id: id(1) });
  for (const line of f.lines) assert.ok(line.endsWith("\n") && Buffer.byteLength(line, "utf8") <= 384);
  assert.equal(f.timers.size, 0);
  assert.doesNotMatch(f.lines.join(""), /"(?:donation|ack|ping)"|wallet|invoice|payout|private|led/i);
});

test("fallback sends only begin and commit, including a synchronous ACK during write", async () => {
  const f = fixture({ automatic: true, immediate: true }); f.transport.setSupported(true);
  assert.equal(await f.transport.show(card({ amount: "<0.01" })), true);
  assert.deepEqual(f.commands(), [
    { v: 1, type: "board", id: id(1), nick: "GX", amount: "<0.01", rank: "2", image: false },
    { v: 1, type: "boardshow", id: id(1) },
  ]);
  assert.equal(f.timers.size, 0);
});

test("unsupported firmware, malformed cards and a closed transport never write", async () => {
  const f = fixture(); assert.equal(f.transport.supported, false); assert.equal(await f.transport.show(card()), false); assert.equal(f.lines.length, 0);
  f.transport.setSupported(true);
  for (const changes of [{ id: "1" }, { id: `${id(1)}\n` }, { nick: "" }, { nick: " X " }, { nick: "X".repeat(25) },
    { nick: "GX\n" }, { nick: "💜" }, { amount: "0" }, { amount: "0.00" }, { amount: "01" }, { amount: "1,80" },
    { amount: "3,000.123" }, { amount: "300\n" }, { amount: "1e3" }, { amount: "1".repeat(111) },
    { amount: "300 CHOG" }, { rank: "2" }, { rank: 0 }, { rank: 21 }, { image: undefined },
    { image: Buffer.alloc(8191) }, { image: Buffer.alloc(8193) }, { image: new Uint8Array(8192) }]) {
    assert.equal(await f.transport.show(card(changes)), false, String(Object.keys(changes)));
  }
  assert.equal(f.lines.length, 0);
  f.transport.close(); f.transport.setSupported(true);
  assert.equal(f.transport.supported, false); assert.equal(await f.transport.show(card()), false); assert.equal(f.lines.length, 0);
});

test("maximum bounded amount and normalized nickname fit the UTF-8 begin-line budget", async () => {
  const f = fixture({ automatic: true }); f.transport.setSupported(true);
  assert.equal(await f.transport.show(card({ nick: "Я".repeat(24), amount: "1".repeat(110) })), true);
  assert.ok(Buffer.byteLength(f.lines[0], "utf8") <= 384);
});

test("each command has at most two identical attempts and a missing ACK fails without sending any later command", async () => {
  const f = fixture(); f.transport.setSupported(true); const result = f.transport.show(card());
  assert.equal(f.lines.length, 1); await f.advance(1199); assert.equal(f.lines.length, 1);
  await f.advance(1); assert.equal(f.lines.length, 2); assert.equal(f.lines[0], f.lines[1]);
  await f.advance(1200); assert.equal(await result, false); assert.equal(f.transport.busy, false); assert.equal(f.timers.size, 0);
  await f.advance(10_000); assert.equal(f.lines.length, 2);
});

test("a lost chunk ACK retries only the identical chunk; wrong offsets cannot advance pixels or commit", async () => {
  const f = fixture(); f.transport.setSupported(true); const result = f.transport.show(card({ image: Buffer.alloc(8192, 0x3a) }));
  assert.equal(f.transport.receive(ack("ready", 0)), true); await flush();
  assert.equal(f.commands().at(-1).offset, "0"); const firstChunk = f.lines.at(-1);
  assert.equal(f.transport.receive(ack("chunk", 128)), false); assert.equal(f.transport.receive(ack("shown", 4096)), false);
  await f.advance(1200); assert.equal(f.lines.at(-1), firstChunk); assert.equal(f.lines.length, 3);
  assert.equal(f.transport.receive(ack("chunk", 64)), true); await flush();
  assert.equal(f.commands().at(-1).offset, "64"); assert.equal(f.lines.length, 4);
  f.transport.cancel(); assert.equal(await result, false); assert.equal(f.timers.size, 0);
});

test("no overlapping show queues, stable support pongs do not cancel, and commit requires the correct shown offset", async () => {
  const f = fixture(); f.transport.setSupported(true); const first = f.transport.show(card());
  assert.equal(await f.transport.show(card({ id: id(2) })), false); assert.equal(f.lines.length, 1);
  f.transport.setSupported(true); assert.equal(f.transport.receive({ v: 1, type: "pong", board: 1 }), false); assert.equal(f.transport.busy, true);
  assert.equal(f.transport.receive(ack("ready", 0)), true); await flush(); assert.equal(f.lines.length, 2);
  assert.equal(f.transport.receive(ack("shown", 4096)), false); assert.equal(f.transport.busy, true);
  assert.equal(f.transport.receive(ack("shown", 0)), true); assert.equal(await first, true);
});

test("donation cancellation resolves immediately, and late ACKs/timers cannot continue an old generation or a new ID", async () => {
  const f = fixture(); f.transport.setSupported(true); const first = f.transport.show(card({ image: Buffer.alloc(8192) }));
  assert.equal(f.transport.receive(ack("ready", 0)), true); await flush(); assert.equal(f.lines.length, 2);
  f.transport.cancel(); assert.equal(await first, false); assert.equal(f.transport.busy, false); assert.equal(f.timers.size, 0);
  assert.equal(await f.transport.show(card()), false, "recent wire IDs must not be reused after cancellation");
  const second = f.transport.show(card({ id: id(2) })); const before = f.lines.length;
  assert.equal(f.transport.receive(ack("chunk", 64)), false); assert.equal(f.transport.receive(ack("ready", 0)), false);
  await flush(); assert.equal(f.lines.length, before);
  assert.equal(f.transport.receive(ack("ready", 0, id(2))), true); await flush();
  assert.equal(f.transport.receive(ack("shown", 0, id(2))), true); assert.equal(await second, true);
  await f.advance(5000); assert.equal(f.lines.length, before + 1);
});

for (const signal of [{ v: 1, type: "hello", last: "", board: 1 }, { v: 1, type: "fault" },
  { v: 1, type: "ack", id: id(9), status: "accepted" }, { v: 1, type: "ack", id: id(9), status: "done" }]) {
  test(`${signal.type}/${signal.status ?? "reset"} immediately cancels a board transfer without consuming donation messages`, async () => {
    const f = fixture(); f.transport.setSupported(true); const result = f.transport.show(card());
    assert.equal(f.transport.receive(signal), false); assert.equal(await result, false); assert.equal(f.transport.busy, false);
    assert.equal(f.transport.receive(ack("ready", 0)), false); await f.advance(10_000); assert.equal(f.lines.length, 1);
  });
}

test("canSend is checked immediately before every write and support removal/close cancel pending work", async () => {
  const f = fixture(); f.transport.setSupported(true); f.allow(false); assert.equal(await f.transport.show(card()), false); assert.equal(f.lines.length, 0);
  f.allow(true); const first = f.transport.show(card()); f.allow(false);
  assert.equal(f.transport.receive(ack("ready", 0)), true); assert.equal(await first, false); assert.equal(f.lines.length, 1);
  f.allow(true); const second = f.transport.show(card({ id: id(2) })); f.transport.setSupported(false);
  assert.equal(await second, false); assert.equal(f.transport.supported, false);
  f.transport.setSupported(true); const third = f.transport.show(card({ id: id(3) })); f.transport.close();
  assert.equal(await third, false); assert.equal(f.transport.busy, false); assert.equal(f.timers.size, 0);
});

test("write errors fail closed, and an old asynchronous write rejection cannot cancel a newer board show", async () => {
  let reject;
  const timers = new Map(); let serial = 0;
  const transport = createStationBoardTransport({ write: () => new Promise((_resolve, no) => { reject = no; }), setTimer: callback => { timers.set(++serial, callback); return serial; }, clearTimer: handle => timers.delete(handle) });
  transport.setSupported(true); const first = transport.show(card()); const oldReject = reject;
  transport.cancel(); assert.equal(await first, false);
  const second = transport.show(card({ id: id(2) })); oldReject(new Error("old write failed")); await flush(); assert.equal(transport.busy, true);
  reject(new Error("current write failed")); assert.equal(await second, false); assert.equal(timers.size, 0);
  const broken = createStationBoardTransport({ write() { throw new Error("USB unavailable"); } }); broken.setSupported(true);
  assert.equal(await broken.show(card()), false); assert.equal(broken.busy, false); broken.close();
});

test("the bounded recent-ID guard does not stop a station after hundreds of fresh shows", async () => {
  const f = fixture({ automatic: true, immediate: true }); f.transport.setSupported(true);
  for (let index = 1; index <= 300; index++) assert.equal(await f.transport.show(card({ id: id(index) })), true);
  assert.equal(f.lines.length, 600); assert.equal(f.transport.supported, true); assert.equal(f.transport.busy, false); assert.equal(f.timers.size, 0);
});
