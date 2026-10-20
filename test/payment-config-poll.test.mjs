import test from "node:test";
import assert from "node:assert/strict";
import { startPaymentConfigPolling } from "../src/payment-config-poll.ts";

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a twelve-second config read stays valid and polls never overlap", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred(), received = [];
  let calls = 0, failures = 0;
  const stop = startPaymentConfigPolling(() => {
    calls++;
    return first.promise;
  }, config => received.push(config), () => failures++);
  t.after(stop);

  t.mock.timers.tick(12_000);
  await settle();
  assert.equal(calls, 1, "a slow read does not launch another request at ten seconds");
  assert.equal(failures, 0, "a healthy read is not rejected after eight seconds");
  first.resolve({ ready: true });
  await settle();
  assert.deepEqual(received, [{ ready: true }]);
  t.mock.timers.tick(9_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2, "the next poll starts ten seconds after completion");
});

test("a config read is aborted at thirty seconds, fails closed, and retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, failures = 0, requestSignal;
  const received = [];
  const stop = startPaymentConfigPolling(signal => {
    calls++;
    requestSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, config => received.push(config), () => failures++);
  t.after(stop);

  t.mock.timers.tick(29_999);
  assert.equal(requestSignal.aborted, false);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requestSignal.aborted, true);
  assert.equal(failures, 1);
  assert.deepEqual(received, []);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 2);
});

test("disposing a cause aborts its read and ignores late results even if transport ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = deferred(), received = [];
  let oldSignal, calls = 0, failures = 0;
  const stopOld = startPaymentConfigPolling(signal => {
    oldSignal = signal;
    calls++;
    return old.promise;
  }, config => received.push(config), () => failures++);
  stopOld();
  assert.equal(oldSignal.aborted, true);
  const stopNew = startPaymentConfigPolling(async () => ({ cause: "current" }), config => received.push(config), () => failures++);
  t.after(stopNew);
  await settle();
  old.resolve({ cause: "old" });
  await settle();
  assert.deepEqual(received, [{ cause: "current" }]);
  assert.equal(failures, 0, "cleanup is not presented as a service outage");
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1, "a disposed cause never schedules another request");
});

test("an expired read cannot publish a late config and a failed read can recover", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired = deferred(), received = [];
  let calls = 0, failures = 0;
  const stop = startPaymentConfigPolling(async () => {
    calls++;
    return calls === 1 ? expired.promise : { ready: true };
  }, config => received.push(config), () => failures++);
  t.after(stop);
  t.mock.timers.tick(30_000);
  expired.resolve({ ready: true, stale: true });
  await settle();
  await settle();
  assert.deepEqual(received, []);
  assert.equal(failures, 1);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(received, [{ ready: true }]);
});
