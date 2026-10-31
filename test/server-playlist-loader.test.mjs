import test from "node:test";
import assert from "node:assert/strict";
import Hls from "hls.js";
import { liveHlsConfig } from "../src/live-player.ts";
import { createServerPlaylistLoader } from "../src/server-playlist-loader.ts";

function fakeNetwork(t) {
  const previous = globalThis.self, pending = new Map(), requests = [];
  let now = 100, nextId = 0;
  class TestXHR {
    readyState = 0; status = 0; aborted = false; responseText = "";
    constructor() { requests.push(this); }
    open(method, url) { assert.equal(method, "GET"); assert.equal(new URL(url).hostname, "example.invalid"); this.responseURL = url; this.readyState = 1; }
    send() {}
    abort() { this.aborted = true; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ""; }
    getResponseHeader() { return null; }
    headers() { this.readyState = 2; this.onreadystatechange?.(); }
    finish() {
      this.status = 200; this.readyState = 4;
      this.responseText = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:1,\nsegment-100.mp4\n";
      this.onreadystatechange?.();
    }
  }
  globalThis.self = {
    XMLHttpRequest: TestXHR, performance: { now: () => now }, location: { href: "https://example.invalid/" },
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  t.after(() => { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; });
  return {
    requests,
    advance(milliseconds) {
      const end = now + milliseconds;
      for (let calls = 0; calls < 100; calls++) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) { now = end; return; }
        pending.delete(due[0]); now = due[1].at; due[1].callback();
      }
      assert.fail("Synthetic request produced an unbounded timer loop");
    },
  };
}

const trackTypes = {
  level: { collection: "levels", loading: Hls.Events.LEVEL_LOADING, loaded: Hls.Events.LEVEL_LOADED, timeout: "levelLoadTimeOut" },
  audioTrack: { collection: "audioTracks", loading: Hls.Events.AUDIO_TRACK_LOADING, loaded: Hls.Events.AUDIO_TRACK_LOADED, timeout: "audioTrackLoadTimeOut" },
  subtitleTrack: { collection: "subtitleTracks", loading: Hls.Events.SUBTITLE_TRACK_LOADING, loaded: Hls.Events.SUBTITLE_TRACK_LOADED, timeout: "subtitleTrackLoadTimeOut" },
};

function blockingRequest(t, network, useServerLoader = true, type = "level") {
  const config = liveHlsConfig(1, Hls.DefaultConfig, "server");
  const hls = new Hls({ ...config, ...(useServerLoader ? {} : { pLoader: undefined }),
    autoStartLoad: false, enableWorker: false });
  t.after(() => hls.destroy());
  const errors = [], loaded = [];
  hls.on(Hls.Events.ERROR, (_event, data) => { errors.push(data); hls.stopLoad(); });
  hls.on(trackTypes[type].loaded, (_event, data) => loaded.push(data));
  const level = { details: { partTarget: 0.2, targetduration: 1 } };
  Object.defineProperty(hls, trackTypes[type].collection, { value: [level], configurable: true });
  // The real PlaylistLoader applies its 800 ms LL-HLS clamp before constructing
  // our pLoader, exactly as it does after a live controller requests a reload.
  hls.trigger(trackTypes[type].loading, {
    id: 0, level: 0, levelInfo: level, track: level, groupId: "synthetic",
    url: "https://example.invalid/live/station/media.m3u8?_HLS_msn=107&_HLS_part=2",
    deliveryDirectives: { msn: 107, part: 2 },
  });
  assert.equal(network.requests.length, 1);
  return { hls, xhr: network.requests[0], errors, loaded };
}

for (const type of Object.keys(trackTypes)) {
test(`the real PlaylistLoader still clamps an unwrapped blocking ${type} request to 800 ms`, t => {
  const network = fakeNetwork(t), fixture = blockingRequest(t, network, false, type);
  network.advance(799);
  assert.equal(fixture.xhr.aborted, false);
  network.advance(1);
  assert.equal(fixture.xhr.aborted, true);
  assert.equal(fixture.errors.filter(error => error.details === trackTypes[type].timeout).length, 1);
});

test(`the real server pLoader keeps a blocking ${type} request alive past 800 ms and accepts its later playlist`, t => {
  const network = fakeNetwork(t), fixture = blockingRequest(t, network, true, type);
  assert.equal(typeof fixture.hls.config.pLoader, "function", "The production server configuration installs the extension");
  assert.equal(liveHlsConfig(1, Hls.DefaultConfig, "relay").pLoader, undefined);
  network.advance(2_000);
  assert.equal(fixture.xhr.aborted, false);
  assert.equal(fixture.errors.length, 0);
  fixture.xhr.headers();
  network.advance(1_000);
  fixture.xhr.finish();
  assert.equal(fixture.errors.length, 0);
  assert.equal(fixture.loaded.length, 1);
  assert.equal(fixture.loaded[0].details.startSN, 100);
  assert.equal(fixture.loaded[0].stats.retry, 0);
  assert.equal(fixture.xhr.aborted, false);
});

test(`the real server pLoader still aborts ${type} at four seconds without headers`, t => {
  const network = fakeNetwork(t), fixture = blockingRequest(t, network, true, type);
  network.advance(3_999);
  assert.equal(fixture.xhr.aborted, false);
  network.advance(1);
  assert.equal(fixture.xhr.aborted, true);
  assert.equal(fixture.errors.filter(error => error.details === trackTypes[type].timeout).length, 1);
});

test(`headers do not extend the real server ${type} pLoader beyond its eight-second total budget`, t => {
  const network = fakeNetwork(t), fixture = blockingRequest(t, network, true, type);
  network.advance(1_000); fixture.xhr.headers();
  network.advance(6_999);
  assert.equal(fixture.xhr.aborted, false);
  network.advance(1);
  assert.equal(fixture.xhr.aborted, true);
  assert.equal(fixture.errors.filter(error => error.details === trackTypes[type].timeout).length, 1);
});
}

test("the extension preserves lower configured budgets, retry callbacks and shared request policies", () => {
  const calls = [];
  class RecordingLoader { load(...args) { calls.push(args); } }
  const Loader = createServerPlaylistLoader(RecordingLoader);
  const shouldRetry = () => false;
  const retry = { maxNumRetry: 2, retryDelayMs: 100, maxRetryDelayMs: 200, shouldRetry };
  const request = { timeout: 800, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0, highWaterMark: 16,
    loadPolicy: { maxTimeToFirstByteMs: 800, maxLoadTimeMs: 800, timeoutRetry: null, errorRetry: retry } };
  const context = { type: "level", deliveryDirectives: { part: 2 }, url: "https://example.invalid/media.m3u8" };
  const callbacks = { onSuccess() {}, onError() {}, onTimeout() {} };
  const config = { playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 1_500, maxLoadTimeMs: 2_500 } } };
  const before = structuredClone(Hls.DefaultConfig.playlistLoadPolicy);
  new Loader(config).load(context, request, callbacks);
  const [actualContext, actual, actualCallbacks] = calls[0];
  assert.equal(actualContext, context); assert.equal(actualCallbacks, callbacks);
  assert.notEqual(actual, request); assert.notEqual(actual.loadPolicy, request.loadPolicy);
  assert.equal(actual.loadPolicy.maxTimeToFirstByteMs, 1_500);
  assert.equal(actual.loadPolicy.maxLoadTimeMs, 2_500);
  assert.equal(actual.loadPolicy.errorRetry, retry); assert.equal(actual.loadPolicy.errorRetry.shouldRetry, shouldRetry);
  assert.equal(actual.loadPolicy.timeoutRetry, null); assert.equal(actual.highWaterMark, 16);
  assert.equal(request.loadPolicy.maxTimeToFirstByteMs, 800); assert.equal(request.loadPolicy.maxLoadTimeMs, 800);
  assert.deepEqual(config.playlistLoadPolicy.default, { maxTimeToFirstByteMs: 1_500, maxLoadTimeMs: 2_500 });
  assert.deepEqual(Hls.DefaultConfig.playlistLoadPolicy, before);
  for (const [first, total, expectedFirst, expectedTotal] of [
    [60_000, 60_000, 4_000, 8_000], [Infinity, Infinity, 4_000, 8_000], [3_000, 1_000, 1_000, 1_000],
  ]) {
    new Loader({ playlistLoadPolicy: { default: { maxTimeToFirstByteMs: first, maxLoadTimeMs: total } } }).load(context, request, callbacks);
    assert.equal(calls.at(-1)[1].loadPolicy.maxTimeToFirstByteMs, expectedFirst);
    assert.equal(calls.at(-1)[1].loadPolicy.maxLoadTimeMs, expectedTotal);
  }
  for (const type of Object.keys(trackTypes)) {
    new Loader(config).load({ ...context, type }, request, callbacks);
    assert.equal(calls.at(-1)[1].loadPolicy.maxTimeToFirstByteMs, 1_500);
    assert.equal(calls.at(-1)[1].loadPolicy.maxLoadTimeMs, 2_500);
    for (const part of [undefined, null, NaN, Infinity, -1]) {
      const otherContext = { ...context, type, deliveryDirectives: part === undefined ? null : { part } };
      new Loader(config).load(otherContext, request, callbacks);
      assert.equal(calls.at(-1)[1], request, `Nonblocking ${type} policies pass through unchanged`);
    }
  }
  for (const type of ["manifest", "media-fragment"]) {
    new Loader(config).load({ ...context, type }, request, callbacks);
    assert.equal(calls.at(-1)[1], request, `${type} policies pass through unchanged`);
  }
});
