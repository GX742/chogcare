import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStationController, parseStationArgs, stationWorkerHealthy, validStationDeviceMessage } from "../scripts/station-bridge.mjs";

const donation = { v: 1, type: "donation", id: "a".repeat(24), nick: "GX", amount: "300" };
function controller() {
  let clock = 1000;
  const wires = [], completed = [], faults = [];
  const device = createStationController({ write: line => wires.push(JSON.parse(line)), done: id => completed.push(id), onFault: () => faults.push(true), now: () => clock });
  return { device, wires, completed, faults, advance(value) { clock += value; } };
}

test("USB bridge requires device handshake and healthy worker before a donation command", () => {
  const f = controller(); f.device.offer(donation); f.device.tick(true);
  assert.deepEqual(f.wires, [{ v: 1, type: "ping" }]);
  f.device.receive({ v: 1, type: "hello", last: "" }); f.advance(1000); f.device.tick(false);
  assert.equal(f.wires.filter(item => item.type === "donation").length, 0);
  f.advance(1000); f.device.tick(true); assert.deepEqual(f.wires.at(-1), donation);
});

test("lost accepted ACK retries identical payload, not a new event identity", () => {
  const f = controller(); f.device.receive({ v: 1, type: "pong" }); f.device.offer(donation); f.device.tick(true);
  f.advance(4999); f.device.tick(true); assert.equal(f.wires.filter(item => item.type === "donation").length, 1);
  f.advance(1); f.device.tick(true); assert.deepEqual(f.wires.filter(item => item.type === "donation"), [donation, donation]);
});

test("accepted gratitude waits for done and does not restart during its animation", () => {
  const f = controller(); f.device.receive({ v: 1, type: "pong" }); f.device.offer(donation); f.device.tick(true);
  assert.equal(f.device.receive({ v: 1, type: "ack", id: donation.id, status: "accepted" }), true);
  f.advance(59_999); f.device.tick(true); assert.equal(f.wires.filter(item => item.type === "donation").length, 1);
  f.device.receive({ v: 1, type: "ack", id: donation.id, status: "done" });
  assert.deepEqual(f.completed, [donation.id]); assert.equal(f.device.pendingId, null);
  assert.equal(f.device.receive({ v: 1, type: "ack", id: donation.id, status: "done" }), false);
});

test("missing done ACK after accepted timeout retries the same completed token", () => {
  const f = controller(); f.device.receive({ v: 1, type: "pong" }); f.device.offer(donation); f.device.tick(true);
  f.device.receive({ v: 1, type: "ack", id: donation.id, status: "accepted" }); f.advance(60_000); f.device.tick(true);
  assert.deepEqual(f.wires.filter(item => item.type === "donation"), [donation, donation]);
});

test("device reboot immediately retries the same unfinished gratitude token", () => {
  const f = controller(); f.device.receive({ v: 1, type: "hello", last: "" }); f.device.offer(donation); f.device.tick(true);
  f.device.receive({ v: 1, type: "ack", id: donation.id, status: "accepted" });
  f.advance(1000); f.device.receive({ v: 1, type: "hello", last: "b".repeat(24) }); f.device.tick(true);
  assert.deepEqual(f.wires.filter(item => item.type === "donation"), [donation, donation]);
  assert.deepEqual(f.completed, []);
});

test("hardware fault holds pending gratitude and pong cannot clear the fault latch", () => {
  const f = controller(); f.device.receive({ v: 1, type: "hello", last: "" }); f.device.offer(donation);
  f.device.receive({ v: 1, type: "fault" }); f.device.receive({ v: 1, type: "fault" });
  assert.deepEqual(f.faults, [true]); assert.equal(f.device.pendingId, donation.id);
  f.device.receive({ v: 1, type: "pong" }); f.device.tick(true); f.advance(60_000); f.device.tick(true);
  assert.equal(f.wires.filter(item => item.type === "donation").length, 0); assert.deepEqual(f.completed, []);
  f.device.receive({ v: 1, type: "hello", last: "" }); f.device.tick(true);
  assert.deepEqual(f.wires.at(-1), donation);
});

test("only exact pending event ACK or matching persisted hello can consume a gratitude", () => {
  const f = controller(); f.device.offer(donation);
  assert.equal(f.device.receive({ v: 1, type: "ack", id: "b".repeat(24), status: "done" }), false);
  assert.equal(f.device.receive({ v: 1, type: "ack", id: donation.id, status: "done", wallet: "extra" }), false);
  assert.equal(f.device.receive({ v: 1, type: "hello", last: donation.id, debug: true }), false);
  assert.deepEqual(f.completed, []);
  assert.equal(f.device.receive({ v: 1, type: "hello", last: donation.id }), true);
  assert.deepEqual(f.completed, [donation.id]);
});

test("USB controller permits one immutable gratitude event at a time", () => {
  const f = controller(); assert.equal(f.device.offer(donation), true);
  assert.equal(f.device.offer({ ...donation, id: "b".repeat(24) }), false);
  assert.throws(() => f.device.offer({ ...donation, amount: "301" }), /cannot change/);
});

test("device protocol rejects malformed messages and unknown fields", () => {
  for (const message of [null, [], { v: 2, type: "pong" }, { v: 1, type: "hello" }, { v: 1, type: "ack", id: "A".repeat(24), status: "done" }, { v: 1, type: "ack", id: donation.id, status: "success" }, { v: 1, type: "pong", extra: true }, { v: 1, type: "fault", debug: true }]) assert.equal(validStationDeviceMessage(message), false);
});

test("health probe is hardcoded to loopback and fails closed", async () => {
  const good = { custodyConfigured: true, paymentsEnabled: true, integrityLocked: false, readiness: { processing: "connected" } };
  const fetcher = body => async (url, options) => { assert.equal(url, "http://127.0.0.1:4174/api/payments/config"); assert.equal(options.redirect, "error"); return new Response(JSON.stringify(body)); };
  assert.equal(await stationWorkerHealthy(fetcher(good)), true);
  assert.equal(await stationWorkerHealthy(fetcher({ ...good, paymentsEnabled: false })), true, "paused invoice creation must not suppress an already-finalized gift");
  for (const body of [{ ...good, integrityLocked: true }, { ...good, integrityLocked: undefined }, { ...good, custodyConfigured: false }, { ...good, readiness: {} }, {}]) assert.equal(await stationWorkerHealthy(fetcher(body)), false);
  assert.equal(await stationWorkerHealthy(async () => { throw new Error("offline"); }), false);
  assert.equal(await stationWorkerHealthy(async () => new Response("x".repeat(17_000))), false);
});

test("native USB transport tolerates malformed boot chatter but keeps command input strict", async () => {
  const script = await readFile(new URL("../scripts/station-serial.ps1", import.meta.url), "utf8");
  assert.match(script, /\$stationEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false,\s*\$true\)/);
  assert.match(script, /\$stationSerialEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false,\s*\$false\)/);
  assert.match(script, /\$stationSerial\.Encoding\s*=\s*\$stationSerialEncoding/);
  assert.match(script, /\$stationInputReader\s*=\s*\[System\.IO\.StreamReader\]::new\(\$stationInputStream,\s*\$stationEncoding/);
  assert.match(script, /\$stationSerial\.DtrEnable\s*=\s*\$false/);
  assert.match(script, /\$stationSerial\.RtsEnable\s*=\s*\$false/);
});

test("CLI explicitly chooses COM transport or non-hardware simulation", () => {
  assert.deepEqual(parseStationArgs(["--port", "com6"]), { port: "COM6", demo: false, simulate: false });
  assert.deepEqual(parseStationArgs(["--port", "COM6", "--demo"]), { port: "COM6", demo: true, simulate: false });
  assert.deepEqual(parseStationArgs(["--simulate"]), { port: null, demo: false, simulate: true });
  for (const args of [[], ["--demo"], ["--port", "COM0"], ["--port", "COM6;bad"], ["--simulate", "--port", "COM6"], ["--url", "https://example.com"], ["--port", "COM6", "--demo", "--demo"]]) assert.throws(() => parseStationArgs(args));
});
