import test from "node:test";
import assert from "node:assert/strict";
import { createLivePlaybackRecovery } from "../src/live-recovery.ts";
import { createLiveLoadState } from "../src/live-player.ts";

const flushPromises = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function fakeClock() {
  let timestamp = 0, sequence = 0, maximumPending = 0;
  const pending = new Map();
  return {
    now: () => timestamp,
    schedule(callback, delay) {
      const id = ++sequence;
      pending.set(id, { callback, at: timestamp + delay });
      maximumPending = Math.max(maximumPending, pending.size);
      return id;
    },
    cancel(id) { pending.delete(id); },
    async advance(milliseconds) {
      const until = timestamp + milliseconds;
      let fired = 0;
      while (true) {
        const next = [...pending.entries()].filter(([, item]) => item.at <= until)
          .sort(([firstId, first], [secondId, second]) => first.at - second.at || firstId - secondId)[0];
        if (!next) break;
        assert.ok(++fired < 10_000, "A recovery timer must not create a hot retry loop");
        timestamp = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
        await flushPromises();
      }
      timestamp = until;
      await flushPromises();
    },
    get size() { return pending.size; },
    get maximumPending() { return maximumPending; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function playerFixture() {
  const clock = fakeClock(), states = [], calls = { play: [], load: [], reconnect: [], playing: [], waiting: [] };
  let active = true, playBehavior, reconnectBehavior;
  const media = {
    currentTime: 10, paused: true, ended: false, seeking: false, readyState: 4,
    play() {
      calls.play.push(clock.now());
      if (playBehavior) return playBehavior();
      media.paused = false;
      media.ended = false;
      return Promise.resolve();
    },
  };
  const monitor = createLiveLoadState({
    onChange: state => states.push(state), schedule: clock.schedule, cancel: clock.cancel,
  });
  const recovery = createLivePlaybackRecovery({
    media, active: () => active, monitor,
    resumeLoading() { calls.load.push(clock.now()); },
    reconnect() { calls.reconnect.push(clock.now()); reconnectBehavior?.(); },
    onPlaying() { calls.playing.push(clock.now()); },
    onWaiting() { calls.waiting.push(clock.now()); },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  return {
    clock, states, calls, media, monitor, recovery,
    setActive(value) { active = value; },
    setPlayBehavior(value) { playBehavior = value; },
    setReconnectBehavior(value) { reconnectBehavior = value; },
    async start() { recovery.play(); await flushPromises(); recovery.playing(); },
    dispose() { recovery.dispose(); monitor.dispose(); },
  };
}

test("scrolling a playing video offscreen for more than 15 seconds resumes without a tap or Retry", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.setActive(false);
  fixture.media.paused = true;
  fixture.recovery.paused();
  fixture.recovery.waiting();
  await fixture.clock.advance(30_000);
  assert.equal(fixture.clock.size, 0, "Offscreen playback does not consume recovery timers");
  assert.equal(fixture.calls.play.length, 1);
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.states.includes("blocked"), false);
  assert.equal(fixture.states.includes("unavailable"), false);

  fixture.setActive(true);
  fixture.recovery.resume();
  await flushPromises();
  assert.equal(fixture.calls.play.length, 2, "Returning to the video starts it automatically");
  assert.equal(fixture.calls.load.length, 1);
  assert.equal(fixture.monitor.state, "playing");
  assert.equal(fixture.calls.reconnect.length, 0, "A browser suspension does not unnecessarily rebuild the stream");
  fixture.dispose();
});

test("a visible browser pause attempts muted playback instead of claiming autoplay is blocked", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.media.paused = true;
  fixture.recovery.paused();
  assert.notEqual(fixture.monitor.state, "blocked");
  await fixture.clock.advance(250);
  assert.equal(fixture.calls.play.length, 2);
  assert.equal(fixture.monitor.state, "playing");
  assert.equal(fixture.states.includes("blocked"), false);
  assert.equal(fixture.calls.reconnect.length, 0);
  fixture.dispose();
});

test("a genuine autoplay policy rejection waits for a user tap and does not loop", async () => {
  const fixture = playerFixture();
  fixture.setPlayBehavior(() => Promise.reject(new DOMException("A gesture is required", "NotAllowedError")));
  fixture.recovery.play();
  await flushPromises();
  assert.equal(fixture.monitor.state, "blocked");
  for (let index = 0; index < 10; index++) { fixture.recovery.resume(); fixture.recovery.progress(); }
  await fixture.clock.advance(120_000);
  assert.equal(fixture.calls.play.length, 1);
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.clock.size, 0);

  fixture.setPlayBehavior(undefined);
  fixture.recovery.play(true);
  await flushPromises();
  assert.equal(fixture.monitor.state, "playing", "An explicit tap starts the same player");
  assert.equal(fixture.calls.play.length, 2);
  fixture.dispose();
});

test("abort and transient play failures do not produce a false browser-policy prompt", async () => {
  for (const problem of [new DOMException("Playback interrupted", "AbortError"), new Error("Temporary transport failure")]) {
    const fixture = playerFixture();
    fixture.setPlayBehavior(() => Promise.reject(problem));
    fixture.recovery.play();
    await flushPromises();
    assert.equal(fixture.monitor.state, "loading");
    assert.equal(fixture.states.includes("blocked"), false);
    fixture.setPlayBehavior(undefined);
    await fixture.clock.advance(1000);
    assert.equal(fixture.monitor.state, "playing", "A transient pause recovers without manual intervention");
    fixture.dispose();
  }
});

test("a browser-style NotAllowedError object is treated as an actual policy rejection", async () => {
  const fixture = playerFixture();
  fixture.setPlayBehavior(() => Promise.reject({ name: "NotAllowedError", message: "Autoplay denied" }));
  fixture.recovery.play();
  await flushPromises();
  assert.equal(fixture.monitor.state, "blocked");
  assert.equal(fixture.clock.size, 0);
  fixture.dispose();
});

test("source replacement invalidates a stale play rejection before a healthy stream starts", async () => {
  for (const name of ["AbortError", "NotAllowedError"]) {
    const fixture = playerFixture(), previousPlay = deferred();
    fixture.setPlayBehavior(() => previousPlay.promise);
    fixture.recovery.play();
    fixture.recovery.resetSource();
    fixture.setPlayBehavior(undefined);
    fixture.recovery.resume();
    await flushPromises();
    assert.equal(fixture.monitor.state, "playing");
    previousPlay.reject(new DOMException("Old source was discarded", name));
    await flushPromises();
    assert.equal(fixture.monitor.state, "playing");
    assert.equal(fixture.states.includes("blocked"), false);
    fixture.dispose();
  }
});

test("suspension releases a pending play promise and ignores its later rejection", async () => {
  const fixture = playerFixture(), previousPlay = deferred();
  fixture.setPlayBehavior(() => previousPlay.promise);
  fixture.recovery.play();
  fixture.setActive(false);
  fixture.recovery.suspend();
  fixture.setPlayBehavior(undefined);
  fixture.setActive(true);
  fixture.recovery.resume();
  await flushPromises();
  assert.equal(fixture.calls.play.length, 2, "A still-pending old play promise cannot prevent resume");
  assert.equal(fixture.monitor.state, "playing");
  previousPlay.reject(new DOMException("Old offscreen play was blocked", "NotAllowedError"));
  await flushPromises();
  assert.equal(fixture.monitor.state, "playing");
  assert.equal(fixture.states.includes("blocked"), false);
  fixture.dispose();
});

test("a stream frozen without a fatal error is nudged and then reconnected automatically", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.recovery.waiting();
  await fixture.clock.advance(3999);
  assert.equal(fixture.calls.load.length, 0, "Brief buffering does not restart the loader");
  assert.equal(fixture.calls.reconnect.length, 0);
  await fixture.clock.advance(1);
  assert.equal(fixture.calls.load.length, 1, "Four seconds without progress triggers a lightweight nudge");
  await fixture.clock.advance(8999);
  assert.equal(fixture.calls.reconnect.length, 0, "A reconnect retains a bounded backoff");
  await fixture.clock.advance(1);
  assert.equal(fixture.calls.reconnect.length, 1, "Persistent lack of progress triggers a real reconnect");
  assert.equal(fixture.states.includes("blocked"), false);
  fixture.dispose();
});

test("calling play on an already unpaused stalled element does not invent healthy playback", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.recovery.waiting();
  const healthyEvents = fixture.calls.playing.length;
  fixture.recovery.play();
  await flushPromises();
  assert.equal(fixture.monitor.state, "loading");
  assert.equal(fixture.calls.playing.length, healthyEvents, "A resolved promise without a new frame is not playback progress");
  fixture.media.currentTime += .25;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("a silent freeze reports buffering before nudging and does not turn itself healthy on each play call", async () => {
  const fixture = playerFixture();
  await fixture.start();
  const healthyEvents = fixture.calls.playing.length;
  await fixture.clock.advance(4000);
  assert.equal(fixture.calls.load.length, 1);
  assert.equal(fixture.monitor.state, "loading", "A stuck playhead is reported even without a waiting event");
  assert.equal(fixture.calls.playing.length, healthyEvents);
  await fixture.clock.advance(3000);
  assert.equal(fixture.monitor.state, "loading");
  assert.equal(fixture.calls.playing.length, healthyEvents);
  fixture.dispose();
});

test("a producer timestamp restart requires fresh forward progress and avoids a false reconnect loop", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.media.currentTime = 1000;
  fixture.recovery.progress();
  fixture.recovery.waiting();
  fixture.media.currentTime = 0;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "loading", "The backwards jump itself is not evidence of healthy frames");
  await fixture.clock.advance(500);
  fixture.media.currentTime = .5;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing", "New frames need not catch up to the previous session's timestamp");
  for (let index = 0; index < 40; index++) {
    await fixture.clock.advance(500);
    fixture.media.currentTime += .5;
    fixture.recovery.progress();
  }
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.calls.load.length, 0);
  fixture.dispose();
});

test("seek time updates, stale playing events and play promises cannot report LIVE before a frame is ready", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.recovery.waiting();
  const healthyEvents = fixture.calls.playing.length;
  fixture.media.currentTime = 90;
  fixture.media.seeking = true;
  fixture.media.readyState = 1;
  fixture.recovery.progress();
  fixture.recovery.playing();
  assert.equal(fixture.monitor.state, "loading");
  fixture.media.readyState = 4;
  fixture.media.paused = true;
  fixture.recovery.play();
  await flushPromises();
  assert.equal(fixture.monitor.state, "loading", "Even a resolved play promise must respect an in-flight seek");
  assert.equal(fixture.calls.playing.length, healthyEvents);
  fixture.media.seeking = false;
  fixture.media.readyState = 1;
  fixture.recovery.progress();
  fixture.recovery.playing();
  assert.equal(fixture.monitor.state, "loading", "A completed seek with metadata only still has no playable frame");
  fixture.media.readyState = 4;
  fixture.media.currentTime += .25;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing", "Decoded forward progress restores playback without a manual retry");
  fixture.dispose();
});

test("a seek does not fabricate recovery or cancel a required fatal loader repair", async () => {
  const fixture = playerFixture(), repairs = [];
  await fixture.start();
  fixture.recovery.recover(() => repairs.push(fixture.clock.now()), true);
  const healthyEvents = fixture.calls.playing.length;
  fixture.media.currentTime = 100;
  fixture.media.seeking = true;
  fixture.media.readyState = 1;
  fixture.recovery.progress();
  await fixture.clock.advance(1000);
  assert.deepEqual(repairs, [1000]);
  assert.equal(fixture.monitor.state, "loading");
  assert.equal(fixture.calls.playing.length, healthyEvents);
  fixture.media.seeking = false;
  fixture.media.readyState = 4;
  fixture.media.currentTime += .25;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("an unbuffered backwards seek cannot rebase the playback clock before actual frames return", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.media.currentTime = 1000;
  fixture.recovery.progress();
  fixture.recovery.waiting();
  const healthyEvents = fixture.calls.playing.length;
  fixture.media.currentTime = 0;
  fixture.media.seeking = true;
  fixture.media.readyState = 1;
  fixture.recovery.progress();
  fixture.media.seeking = false;
  fixture.media.readyState = 4;
  fixture.media.currentTime = .25;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "loading", "The first actual frame rebases the old session instead of using a seek-generated baseline");
  assert.equal(fixture.calls.playing.length, healthyEvents);
  fixture.media.currentTime = .5;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("an unexpected end of a live stream reconnects instead of waiting for Retry", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.media.ended = true;
  fixture.recovery.waiting();
  await fixture.clock.advance(2000);
  assert.equal(fixture.calls.reconnect.length, 1);
  fixture.media.ended = false;
  fixture.media.paused = false;
  fixture.media.currentTime += 1;
  fixture.recovery.playing();
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("three fast failures enter cooldown and automatically try again after the retry window", async () => {
  const fixture = playerFixture();
  fixture.setReconnectBehavior(() => { throw new Error("Broadcaster temporarily offline"); });
  fixture.recovery.recover();
  await fixture.clock.advance(59_999);
  assert.deepEqual(fixture.calls.reconnect, [1000, 3000, 7000]);
  assert.equal(fixture.monitor.state, "unavailable");
  assert.ok(fixture.clock.maximumPending <= 3, "There is at most one health, UI, and recovery timer");
  await fixture.clock.advance(4001);
  assert.equal(fixture.calls.reconnect.length, 4, "Cooldown must wake itself without a click or tab switch");
  assert.ok(fixture.calls.reconnect[3] >= 60_000 && fixture.calls.reconnect[3] <= 64_000,
    "The retry resumes after cooldown and respects attempts still inside the rolling window");
  assert.equal(fixture.states.includes("blocked"), false);
  fixture.dispose();
});

test("repeated wait and error events share timers and healthy progress cancels pending recovery", async () => {
  const fixture = playerFixture();
  await fixture.start();
  for (let index = 0; index < 100; index++) { fixture.recovery.waiting(); fixture.recovery.recover(); }
  assert.ok(fixture.clock.size <= 3, "Repeated events cannot fan out recovery or watchdog timers");
  await fixture.clock.advance(500);
  fixture.media.currentTime += 1;
  fixture.recovery.progress();
  assert.equal(fixture.monitor.state, "playing");
  for (let index = 0; index < 40; index++) {
    await fixture.clock.advance(500);
    fixture.media.currentTime += .5;
    fixture.recovery.progress();
  }
  assert.equal(fixture.calls.reconnect.length, 0, "A stale error must not reload healthy playback later");
  assert.equal(fixture.calls.play.length, 1, "Progressing playback does not repeatedly call play");
  assert.equal(fixture.calls.load.length, 0);
  assert.ok(fixture.clock.maximumPending <= 3);
  fixture.dispose();
});

test("buffered frames cannot cancel the loader repair required by a fatal HLS error", async () => {
  const fixture = playerFixture(), repairs = [];
  await fixture.start();
  fixture.recovery.recover(() => repairs.push(fixture.clock.now()), true);
  await fixture.clock.advance(500);
  fixture.media.currentTime += .5;
  fixture.recovery.progress();
  fixture.recovery.playing();
  await fixture.clock.advance(500);
  assert.deepEqual(repairs, [1000], "A stopped loader still needs repair while its existing buffer plays");
  assert.equal(fixture.calls.reconnect.length, 0, "The requested engine repair is used before a full rebuild");
  fixture.dispose();
});

test("a required repair suspended offscreen resumes without losing its original recovery operation", async () => {
  const fixture = playerFixture(), repairs = [];
  await fixture.start();
  fixture.recovery.recover(() => repairs.push(fixture.clock.now()), true);
  fixture.setActive(false);
  fixture.recovery.suspend();
  await fixture.clock.advance(30_000);
  assert.deepEqual(repairs, []);
  fixture.setActive(true);
  fixture.recovery.resume();
  await flushPromises();
  fixture.media.currentTime += .5;
  fixture.recovery.progress();
  await fixture.clock.advance(2000);
  assert.equal(repairs.length, 1, "Return to the viewport completes the repair even if buffered playback resumes");
  assert.equal(fixture.calls.reconnect.length, 0);
  fixture.dispose();
});

test("replacing the source cancels an engine repair queued for the discarded source", async () => {
  const fixture = playerFixture(), discardedRepairs = [];
  await fixture.start();
  fixture.recovery.recover(() => discardedRepairs.push(fixture.clock.now()), true);
  fixture.recovery.resetSource();
  fixture.media.currentTime = 0;
  fixture.recovery.playing();
  for (let index = 0; index < 10; index++) {
    await fixture.clock.advance(500);
    fixture.media.currentTime += .5;
    fixture.recovery.progress();
  }
  assert.deepEqual(discardedRepairs, [], "Old-engine operations must not run against the new stream");
  assert.equal(fixture.calls.reconnect.length, 0);
  fixture.dispose();
});

test("offline suspension stops retries and an online resume restarts automatically", async () => {
  const fixture = playerFixture();
  await fixture.start();
  fixture.recovery.recover();
  fixture.setActive(false);
  fixture.media.paused = true;
  fixture.recovery.suspend();
  for (let index = 0; index < 10; index++) { fixture.recovery.resume(); fixture.recovery.recover(); }
  await fixture.clock.advance(90_000);
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.clock.size, 0);
  fixture.setActive(true);
  fixture.recovery.resume();
  await flushPromises();
  assert.equal(fixture.calls.play.length, 2);
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("disposal cancels delayed reconnects and rejects stale promises without new UI or network work", async () => {
  const fixture = playerFixture(), pendingPlay = deferred();
  fixture.setPlayBehavior(() => pendingPlay.promise);
  fixture.recovery.play();
  fixture.recovery.waiting();
  fixture.recovery.recover();
  fixture.dispose();
  const snapshot = structuredClone(fixture.calls), states = [...fixture.states];
  pendingPlay.reject(new DOMException("Disposed source", "NotAllowedError"));
  fixture.recovery.play(true);
  fixture.recovery.paused();
  fixture.recovery.waiting();
  fixture.recovery.progress();
  fixture.recovery.recover();
  fixture.recovery.resume();
  fixture.recovery.resetSource();
  fixture.recovery.playing();
  fixture.recovery.suspend();
  fixture.recovery.unavailable();
  await fixture.clock.advance(120_000);
  assert.equal(fixture.clock.size, 0);
  assert.deepEqual(fixture.calls, snapshot);
  assert.deepEqual(fixture.states, states);
});
