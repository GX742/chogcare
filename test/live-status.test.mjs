import test from "node:test";
import assert from "node:assert/strict";
import { createLivePlaybackStatus } from "../src/live-status.ts";

function statusFixture() {
  let time = 0, sequence = 0;
  const timers = new Map(), changes = [];
  const status = createLivePlaybackStatus({
    onChange: live => changes.push({ live, at: time }),
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
  });
  return {
    status, changes,
    advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, item]) => item.at <= end)
          .sort(([, first], [, second]) => first.at - second.at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = end;
    },
    get pending() { return timers.size; },
  };
}

test("LIVE starts only after playback is observed, not while the initial stream is loading", () => {
  const fixture = statusFixture();
  assert.equal(fixture.status.live, false);
  for (let index = 0; index < 100; index++) fixture.status.waiting();
  fixture.advance(30_000);
  assert.deepEqual(fixture.changes, []);
  assert.equal(fixture.pending, 0);
  fixture.status.playing();
  fixture.status.playing();
  assert.deepEqual(fixture.changes, [{ live: true, at: 30_000 }]);
  fixture.status.dispose();
});

test("brief HLS buffering and a live-edge seek do not flash the established LIVE badge", () => {
  const fixture = statusFixture();
  fixture.status.playing();
  fixture.status.waiting();
  fixture.advance(1800);
  assert.equal(fixture.status.live, true);
  fixture.status.playing();
  fixture.advance(1000);
  fixture.status.waiting();
  fixture.advance(2000);
  fixture.status.playing();
  fixture.advance(10_000);
  assert.deepEqual(fixture.changes, [{ live: true, at: 0 }]);
  assert.equal(fixture.pending, 0);
  fixture.status.dispose();
});

test("repeated waiting events cannot hide a persistent interruption by restarting the grace period", () => {
  const fixture = statusFixture();
  fixture.status.playing(); fixture.status.waiting();
  for (let index = 0; index < 24; index++) {
    fixture.advance(100);
    fixture.status.waiting();
    assert.equal(fixture.pending, 1);
  }
  assert.equal(fixture.status.live, true);
  fixture.advance(100);
  assert.equal(fixture.status.live, false);
  assert.deepEqual(fixture.changes, [{ live: true, at: 0 }, { live: false, at: 2500 }]);
  for (let index = 0; index < 100; index++) fixture.status.waiting();
  assert.equal(fixture.pending, 0, "An interrupted badge does not create repeated timers");
  fixture.status.playing();
  assert.equal(fixture.status.live, true, "Real playback restores LIVE immediately");
  fixture.status.dispose();
});

test("a confirmed unavailable or blocked player clears LIVE immediately and cancels stale grace", () => {
  const fixture = statusFixture();
  fixture.status.playing(); fixture.status.waiting();
  fixture.advance(100);
  fixture.status.unavailable();
  assert.equal(fixture.status.live, false);
  assert.equal(fixture.pending, 0);
  fixture.status.playing();
  fixture.advance(5000);
  assert.equal(fixture.status.live, true, "The previous grace timer cannot turn a restored stream off");
  assert.deepEqual(fixture.changes.map(change => change.live), [true, false, true]);
  fixture.status.dispose();
});

test("offscreen suspension cancels grace, and return starts a fresh bounded wait", () => {
  const fixture = statusFixture();
  fixture.status.playing(); fixture.status.waiting();
  fixture.advance(1000); fixture.status.suspend();
  fixture.advance(60_000);
  assert.equal(fixture.status.live, true, "Hidden playback does not flash a visible connection state");
  assert.equal(fixture.pending, 0);
  fixture.status.waiting();
  fixture.advance(2499);
  assert.equal(fixture.status.live, true);
  fixture.advance(1);
  assert.equal(fixture.status.live, false, "A failed resume is still reported after the normal grace");
  fixture.status.dispose();
});

test("late offscreen waiting events preserve LIVE and cannot re-arm a suspended grace timer", () => {
  const fixture = statusFixture();
  fixture.status.playing(); fixture.status.waiting();
  fixture.advance(1000);
  fixture.status.waiting(false);
  assert.equal(fixture.pending, 0, "An offscreen event cancels an already armed grace timer");
  fixture.status.suspend();
  for (let index = 0; index < 6; index++) {
    fixture.advance(5000);
    fixture.status.waiting(false);
    assert.equal(fixture.pending, 0, "Queued offscreen pause/wait events cannot start another countdown");
  }
  assert.equal(fixture.status.live, true);
  assert.deepEqual(fixture.changes, [{ live: true, at: 0 }]);
  fixture.status.waiting(true);
  fixture.advance(2499);
  assert.equal(fixture.status.live, true);
  fixture.advance(1);
  assert.equal(fixture.status.live, false, "A genuinely stalled visible return still reports its interruption");
  fixture.status.dispose();
});

test("disposal cancels scheduled status changes and makes later events inert", () => {
  const fixture = statusFixture();
  fixture.status.playing(); fixture.status.waiting(); fixture.status.dispose();
  const before = [...fixture.changes];
  fixture.status.playing(); fixture.status.waiting(); fixture.status.unavailable(); fixture.status.suspend();
  fixture.advance(30_000);
  assert.deepEqual(fixture.changes, before);
  assert.equal(fixture.pending, 0);
});
