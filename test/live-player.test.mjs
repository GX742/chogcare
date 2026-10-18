import test from "node:test";
import assert from "node:assert/strict";
import { createLiveDriftSync, createLiveLoadState, createLiveResumeSync, createLiveRetryBudget, DEFAULT_LIVE_SEGMENT_SECONDS, latestLiveRange, liveHlsConfig, livePlaybackStrategy, liveSegmentSeconds, portraitFrameAspect, recoverLiveNetwork, safeLiveResumeTarget } from "../src/live-player.ts";

test("portrait camera frame uses the actual ratio without scaling/cropping landscape fallback footage", () => {
  assert.equal(portraitFrameAspect(1080, 1920), 9 / 16);
  assert.equal(portraitFrameAspect(720, 1280), 9 / 16);
  assert.equal(portraitFrameAspect(1080, 1080), 1);
  for (const [width, height] of [[1920,1080], [0,0], [1080,0], [-720,1280], [NaN,1920], [1080,Infinity], [100,1920]]) {
    assert.equal(portraitFrameAspect(width, height), undefined);
  }
});

const ranges = (...pairs) => ({ length: pairs.length, start: index => pairs[index][0], end: index => pairs[index][1] });

test("MSE wins when Chromium also advertises native HLS; native is a capability fallback", () => {
  assert.equal(livePlaybackStrategy(true, true), "hls");
  assert.equal(livePlaybackStrategy(true, false), "hls");
  assert.equal(livePlaybackStrategy(false, true), "native");
  assert.equal(livePlaybackStrategy(false, false), "unsupported");
});

test("Safari uses native HLS even when ManagedMediaSource makes hls.js appear supported", () => {
  assert.equal(livePlaybackStrategy(true, true, true), "native", "iPhone Safari with MMS must use the built-in HLS player");
  assert.equal(livePlaybackStrategy(false, true, true), "native");
  assert.equal(livePlaybackStrategy(true, false, true), "hls", "MMS alone is not evidence of native HLS support");
  assert.equal(livePlaybackStrategy(false, false, true), "unsupported");
  assert.equal(livePlaybackStrategy(true, true, false), "hls", "Chromium's native-HLS claim must not change desktop playback");
});

test("live HLS uses adaptive segment-count latency with a finite recovery threshold", () => {
  const config = liveHlsConfig();
  assert.equal(config.liveSyncDurationCount, 2);
  assert.equal(config.liveMaxLatencyDurationCount, 6);
  assert.ok(config.liveMaxLatencyDurationCount > config.liveSyncDurationCount);
  assert.equal(config.maxLiveSyncPlaybackRate, 1.08);
  assert.equal(config.liveSyncOnStallIncrease, 0);
  assert.equal(config.maxBufferLength, 4);
  assert.equal(config.maxMaxBufferLength, 8);
  assert.equal(config.backBufferLength, 4);
  assert.equal(config.lowLatencyMode, true);
  assert.equal(config.enableWorker, true);
  for (const property of ["liveSyncDuration", "liveMaxLatencyDuration", "startLevel", "loadLevel", "currentLevel", "capLevelToPlayerSize"]) assert.equal(Object.hasOwn(config, property), false, property);
  assert.equal(config.liveSyncDurationCount * 3, 6, "Legacy 3s segments retain a bounded client target");
  assert.equal(config.liveSyncDurationCount * 1, 2, "The current one-second segments target two seconds behind the playlist");
  config.maxBufferLength = 999;
  assert.equal(liveHlsConfig().maxBufferLength, 4, "Each player receives its own configuration");
});

test("native HLS resumes two complete segments behind the seekable live edge", () => {
  assert.equal(DEFAULT_LIVE_SEGMENT_SECONDS, 3);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100])), 94);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 1), 98);
  assert.equal(safeLiveResumeTarget(0, ranges([80, 100])), 94);
  assert.equal(safeLiveResumeTarget(1, ranges([10, 12])), 10, "A short window clamps to its safe start");
});

test("safe resume accepts a bounded HLS sync point without seeking to the last frame", () => {
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 88), 88);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 99.9), 97);
  for (const hint of [-1, 100, 1000, NaN, Infinity]) assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, hint), 94);
});

test("live resume never rewinds, never skips small fluctuations and chooses the latest range", () => {
  for (const time of [92, 93, 94, 95, 100, 101]) assert.equal(safeLiveResumeTarget(time, ranges([0, 100])), null, String(time));
  assert.equal(safeLiveResumeTarget(91, ranges([0, 100])), 94);
  assert.equal(safeLiveResumeTarget(10, ranges([0, 20], [70, 100])), 94);
  assert.equal(safeLiveResumeTarget(89, ranges([90, 100])), 94, "A playhead outside the sliding window can move into the safe range");
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
  assert.equal(media.currentTime, 94);
  assert.equal(sync.pending, false);
  assert.equal(timer.size, 0);
  media.seekable = ranges([0, 110]);
  sync.update();
  assert.equal(media.currentTime, 94, "A normal playlist update is not an extra jump");
  sync.request();
  assert.equal(media.currentTime, 104, "An explicit later resume can catch up again");
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

test("native playback catches substantial drift, leaves small drift alone and rate-limits seeks", () => {
  const timer = fakeTimers(); let now = 0;
  const media = { currentTime: 97, seekable: ranges([75, 100]), paused: false, ended: false, seeking: false, readyState: 4 };
  const sync = createLiveDriftSync({ media, segmentSeconds: () => 1, now: () => now, schedule: timer.schedule, cancel: timer.cancel });
  sync.start(); sync.start(); assert.equal(timer.size, 1);
  timer.fire(); assert.equal(media.currentTime, 97, "Normal playback must not hop every update");
  media.currentTime = 70; timer.fire(); assert.equal(media.currentTime, 98);
  media.seekable = ranges([95, 120]); timer.fire(); assert.equal(media.currentTime, 98, "A stalled connection cannot trigger repeated immediate seeks");
  now = 10_000; timer.fire(); assert.equal(media.currentTime, 118);
  sync.dispose(); assert.equal(timer.size, 0); sync.start(); assert.equal(timer.size, 0);
});

test("native drift correction respects visibility, pause, seeking and unavailable media", () => {
  const timer = fakeTimers(); let active = false;
  const media = { currentTime: 70, seekable: ranges([75, 100]), paused: false, ended: false, seeking: false, readyState: 4 };
  const sync = createLiveDriftSync({ media, active: () => active, segmentSeconds: () => 1, schedule: timer.schedule, cancel: timer.cancel });
  sync.start(); timer.fire(); assert.equal(media.currentTime, 70);
  active = true;
  for (const property of ["paused", "ended", "seeking"]) { media[property] = true; timer.fire(); assert.equal(media.currentTime, 70); media[property] = false; }
  media.readyState = 1; timer.fire(); assert.equal(media.currentTime, 70);
  media.readyState = 4; media.seekable = ranges(); timer.fire(); assert.equal(media.currentTime, 70);
  media.seekable = ranges([75, 100]); timer.fire(); assert.equal(media.currentTime, 98);
  sync.dispose();
});
