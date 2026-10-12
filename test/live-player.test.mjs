import test from "node:test";
import assert from "node:assert/strict";
import { createLiveLoadState, createLiveResumeSync, createLiveRetryBudget, DEFAULT_LIVE_SEGMENT_SECONDS, latestLiveRange, liveHlsConfig, livePlaybackStrategy, liveSegmentSeconds, recoverLiveNetwork, safeLiveResumeTarget } from "../src/live-player.ts";

const ranges = (...pairs) => ({ length: pairs.length, start: index => pairs[index][0], end: index => pairs[index][1] });

test("MSE wins when Chromium also advertises native HLS; native is a capability fallback", () => {
  assert.equal(livePlaybackStrategy(true, true), "hls");
  assert.equal(livePlaybackStrategy(true, false), "hls");
  assert.equal(livePlaybackStrategy(false, true), "native");
  assert.equal(livePlaybackStrategy(false, false), "unsupported");
});

test("live HLS uses adaptive segment-count latency with a finite recovery threshold", () => {
  const config = liveHlsConfig();
  assert.equal(config.liveSyncDurationCount, 3);
  assert.equal(config.liveMaxLatencyDurationCount, 6);
  assert.ok(config.liveMaxLatencyDurationCount > config.liveSyncDurationCount);
  assert.equal(config.maxLiveSyncPlaybackRate, 1.08);
  assert.equal(config.liveSyncOnStallIncrease, 0.5);
  assert.equal(config.maxBufferLength, 8);
  assert.equal(config.maxMaxBufferLength, 16);
  assert.equal(config.backBufferLength, 8);
  assert.equal(config.lowLatencyMode, true);
  assert.equal(config.enableWorker, true);
  for (const property of ["liveSyncDuration", "liveMaxLatencyDuration", "startLevel", "loadLevel", "currentLevel", "capLevelToPlayerSize"]) assert.equal(Object.hasOwn(config, property), false, property);
  assert.equal(config.liveSyncDurationCount * 3, 9, "Current 3s segments retain a stable 9s client target");
  assert.equal(config.liveSyncDurationCount * 1, 3, "Shorter server segments lower latency without mixing seconds and counts");
  config.maxBufferLength = 999;
  assert.equal(liveHlsConfig().maxBufferLength, 8, "Each player receives its own configuration");
});

test("native HLS resumes three complete segments behind the seekable live edge", () => {
  assert.equal(DEFAULT_LIVE_SEGMENT_SECONDS, 3);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100])), 91);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 1), 97);
  assert.equal(safeLiveResumeTarget(0, ranges([80, 100])), 91);
  assert.equal(safeLiveResumeTarget(1, ranges([10, 12])), 10, "A short window clamps to its safe start");
});

test("safe resume accepts a bounded HLS sync point without seeking to the last frame", () => {
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 88), 88);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 99.9), 97);
  for (const hint of [-1, 100, 1000, NaN, Infinity]) assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, hint), 91);
});

test("live resume never rewinds, never skips small fluctuations and chooses the latest range", () => {
  for (const time of [89, 90, 91, 95, 100, 101]) assert.equal(safeLiveResumeTarget(time, ranges([0, 100])), null, String(time));
  assert.equal(safeLiveResumeTarget(88, ranges([0, 100])), 91);
  assert.equal(safeLiveResumeTarget(10, ranges([0, 20], [70, 100])), 91);
  assert.equal(safeLiveResumeTarget(89, ranges([90, 100])), 91, "A playhead outside the sliding window can move into the safe range");
  assert.equal(safeLiveResumeTarget(99.5, ranges([100, 100.5])), 100);
});

test("malformed and temporarily unavailable seekable ranges hold instead of throwing or jumping", () => {
  const invalid = [ranges(), null, undefined, {}, { length: -1 }, { length: 1.5 }, { length: 65 }, ranges([-1, 5]), ranges([0, 0]), ranges([5, 4]), ranges([NaN, 5]), ranges([0, Infinity]), ranges([10, 20], [5, 30]), ranges([0, 10], [9, 20]), { length: 1, start: () => { throw new Error("Changed range"); }, end: () => 100 }];
  for (const seekable of invalid) {
    assert.equal(latestLiveRange(seekable), null);
    assert.equal(safeLiveResumeTarget(0, seekable), null);
  }
  for (const time of [NaN, Infinity, -1]) assert.equal(safeLiveResumeTarget(time, ranges([0, 100])), null);
  for (const value of [undefined, null, "1", 0, -1, NaN, Infinity, 61]) assert.equal(liveSegmentSeconds(value), 3);
  for (const value of [0.5, 1, 3, 60]) assert.equal(liveSegmentSeconds(value), value);
});

function fakeTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    schedule(callback, delay) { const id = ++sequence; pending.set(id, { callback, delay }); return id; },
    cancel(id) { pending.delete(id); },
    fire() { const item = pending.entries().next().value; if (!item) return false; pending.delete(item[0]); item[1].callback(); return true; },
    get size() { return pending.size; },
  };
}

test("broadcast loading has one finite watchdog, not an infinite spinner", () => {
  const timer = fakeTimers(), states = [];
  const monitor = createLiveLoadState({ onChange: state => states.push(state), schedule: timer.schedule, cancel: timer.cancel });
  monitor.waiting(); monitor.waiting(); monitor.waiting();
  assert.equal(timer.size, 1);
  timer.fire();
  assert.equal(monitor.state, "unavailable");
  assert.deepEqual(states, ["unavailable"]);
  monitor.waiting(); assert.equal(timer.size, 0, "automatic retries cannot reset the error into a spinner");
  monitor.playing(); assert.equal(monitor.state, "playing", "background recovery can still restore playback");
  monitor.dispose();
});

test("blocked autoplay remains actionable and cancels its loading watchdog", () => {
  const timer = fakeTimers(), states = [];
  const monitor = createLiveLoadState({ onChange: state => states.push(state), schedule: timer.schedule, cancel: timer.cancel });
  monitor.waiting(); monitor.blocked();
  assert.equal(timer.size, 0); assert.equal(monitor.state, "blocked");
  monitor.waiting(); assert.equal(monitor.state, "blocked");
  monitor.playing(); assert.deepEqual(states, ["blocked", "playing"]);
  monitor.dispose();
});

test("a stalled established broadcast times out; hidden/unmounted pages cancel timers", () => {
  const timer = fakeTimers(), states = [];
  const monitor = createLiveLoadState({ onChange: state => states.push(state), schedule: timer.schedule, cancel: timer.cancel });
  monitor.playing(); monitor.waiting(); assert.equal(timer.size, 1);
  monitor.suspend(); assert.equal(timer.size, 0);
  monitor.waiting(); timer.fire(); assert.equal(monitor.state, "unavailable");
  monitor.dispose(); const before = [...states];
  monitor.playing(); monitor.blocked(); monitor.unavailable(); monitor.waiting();
  assert.deepEqual(states, before); assert.equal(timer.size, 0);
});

test("resume synchronizes once after metadata becomes seekable, not on every playlist update", () => {
  const timer = fakeTimers(), media = { currentTime: 20, seekable: ranges() };
  const sync = createLiveResumeSync({ media, schedule: timer.schedule, cancel: timer.cancel });
  sync.request();
  assert.equal(sync.pending, true);
  assert.equal(timer.size, 1);
  media.seekable = ranges([0, 100]);
  sync.update();
  assert.equal(media.currentTime, 91);
  assert.equal(sync.pending, false);
  assert.equal(timer.size, 0);
  media.seekable = ranges([0, 110]);
  sync.update();
  assert.equal(media.currentTime, 91, "A normal playlist update is not an extra jump");
  sync.request();
  assert.equal(media.currentTime, 101, "An explicit later resume can catch up again");
  sync.dispose();
});

test("unavailable media gets only three resume attempts and disposal cancels pending work", () => {
  const timer = fakeTimers(), media = { currentTime: 20, seekable: ranges() };
  const sync = createLiveResumeSync({ media, schedule: timer.schedule, cancel: timer.cancel });
  sync.request();
  assert.equal(timer.fire(), true);
  assert.equal(timer.fire(), true);
  assert.equal(timer.fire(), false);
  assert.equal(sync.pending, false);
  sync.request();
  assert.equal(timer.size, 1);
  sync.dispose();
  assert.equal(timer.size, 0);
  media.seekable = ranges([0, 100]);
  sync.update(); sync.request();
  assert.equal(media.currentTime, 20);
  assert.equal(timer.size, 0);
});

test("media seek exceptions are retried only within the bounded resume budget", () => {
  const timer = fakeTimers();
  let attempted = 0;
  const media = { seekable: ranges([0, 100]), get currentTime() { return 20; }, set currentTime(_value) { attempted++; throw new Error("Not seekable yet"); } };
  const sync = createLiveResumeSync({ media, schedule: timer.schedule, cancel: timer.cancel });
  sync.request();
  while (timer.fire()) { /* Drain at most the two bounded retry timers. */ }
  assert.equal(attempted, 3);
  assert.equal(sync.pending, false);
  sync.dispose();
});

test("fatal recovery has bounded backoff and cannot restart in an infinite immediate loop", () => {
  let now = 100_000;
  const budget = createLiveRetryBudget(() => now);
  assert.equal(budget.nextDelay(), 1000);
  assert.equal(budget.nextDelay(), 2000);
  assert.equal(budget.nextDelay(), 4000);
  for (let index = 0; index < 100; index++) assert.equal(budget.nextDelay(), null);
  now += 60_000;
  assert.equal(budget.nextDelay(), 1000, "A long healthy session does not permanently consume future recovery attempts");
  budget.dispose();
  now += 60_000;
  assert.equal(budget.nextDelay(), null, "Unmounted players cannot schedule a new recovery");
});

test("initial manifest errors retry the manifest request rather than an ineffective startLoad", () => {
  const source = "https://chogcare-stream.tail1f833b.ts.net/hls/stream.m3u8", requests = [];
  const loader = { levels: [], loadSource: url => requests.push(["manifest", url]), startLoad: () => requests.push(["load"]) };
  recoverLiveNetwork(loader, source, "manifestLoadError");
  recoverLiveNetwork(loader, source, "manifestLoadTimeOut");
  recoverLiveNetwork(loader, source, "levelLoadError");
  assert.deepEqual(requests, [["manifest", source], ["manifest", source], ["manifest", source]], "Without levels, a fresh source request is required");
  requests.length = 0;
  loader.levels = [{}];
  recoverLiveNetwork(loader, source, "manifestLoadError");
  recoverLiveNetwork(loader, source, "manifestLoadTimeOut");
  recoverLiveNetwork(loader, source, "levelLoadError");
  recoverLiveNetwork(loader, source, "fragLoadError");
  assert.deepEqual(requests, [["manifest", source], ["manifest", source], ["load"], ["load"]], "Established playback keeps adaptive level/fragment loading");
});
