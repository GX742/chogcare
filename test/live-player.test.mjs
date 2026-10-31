import test from "node:test";
import assert from "node:assert/strict";
import Hls from "hls.js";
import { createLiveDriftSync, createLiveLoadState, createLiveResumeSync, createLiveRetryBudget, DEFAULT_LIVE_SEGMENT_SECONDS, MOBILE_LIVE_SEGMENT_SECONDS, latestLiveRange, liveBufferTiming, liveHlsConfig, livePlaylistKey, livePlaybackTiming, livePlaybackStrategy, liveSegmentSeconds, portraitFrameAspect, recoverLiveNetwork, safeLiveResumeTarget } from "../src/live-player.ts";

test("portrait camera frame uses the actual ratio without scaling/cropping landscape fallback footage", () => {
  assert.equal(portraitFrameAspect(1080, 1920), 9 / 16);
  assert.equal(portraitFrameAspect(720, 1280), 9 / 16);
  assert.equal(portraitFrameAspect(1080, 1080), 1);
  for (const [width, height] of [[1920,1080], [0,0], [1080,0], [-720,1280], [NaN,1920], [1080,Infinity], [100,1920]]) {
    assert.equal(portraitFrameAspect(width, height), undefined);
  }
});

const ranges = (...pairs) => ({ length: pairs.length, start: index => pairs[index][0], end: index => pairs[index][1] });

test("server HLS keeps a short buffer and finite origin timeouts without mutating shared vendor defaults", () => {
  const before=structuredClone(Hls.DefaultConfig.manifestLoadPolicy);
  const config=liveHlsConfig(1,Hls.DefaultConfig,"server");
  assert.equal(config.liveSyncDurationCount,2);
  assert.equal(config.liveMaxLatencyDurationCount,6);
  assert.equal(config.maxBufferLength,4);
  assert.equal(config.maxMaxBufferLength,6);
  assert.equal(config.backBufferLength,2);
  assert.equal(config.lowLatencyMode,false);
  for (const name of ["manifestLoadPolicy","playlistLoadPolicy","fragLoadPolicy"]) {
    assert.equal(config[name].default.maxTimeToFirstByteMs,4000);
    assert.ok(config[name].default.maxLoadTimeMs<=12_000);
    assert.notEqual(config[name].default,Hls.DefaultConfig[name].default);
  }
  config.manifestLoadPolicy.default.maxTimeToFirstByteMs=999;
  assert.deepEqual(Hls.DefaultConfig.manifestLoadPolicy,before);
});

test("the installed HLS controller selects complete server segments instead of the unfinished LL-HLS fragment", t => {
  const oldSelf = globalThis.self;
  globalThis.self = { location: { href: "https://example.invalid/" }, performance };
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const source = "https://example.invalid/live/station/index.m3u8";
  const playlist = [
    "#EXTM3U", "#EXT-X-VERSION:9", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:100",
    "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=3,PART-HOLD-BACK=0.6",
    "#EXT-X-PART-INF:PART-TARGET=0.2", '#EXT-X-MAP:URI="init.mp4"',
    ...Array.from({ length: 7 }, (_, index) => `#EXTINF:1.0,\nsegment-${100 + index}.mp4`),
    '#EXT-X-PART:DURATION=0.2,URI="part-107-0.mp4",INDEPENDENT=YES',
    '#EXT-X-PART:DURATION=0.2,URI="part-107-1.mp4"',
    '#EXT-X-PART:DURATION=0.2,URI="part-107-2.mp4"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-107-3.mp4"', "",
  ].join("\n");
  // Exercise the installed playlist parser and controller. Only the byte source
  // is replaced: this fixture cannot perform an HTTP request or load media.
  class PlaylistFixtureLoader {
    constructor() {
      this.stats = { aborted: false, loaded: playlist.length, total: playlist.length, retry: 0, chunkCount: 1,
        bwEstimate: 0, loading: { start: 1, first: 2, end: 3 }, parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 } };
    }
    load(context, _config, callbacks) {
      assert.equal(context.url, source);
      assert.equal(context.responseType, "text");
      this.context = context;
      callbacks.onSuccess({ url: source, data: playlist, code: 200 }, this.stats, context, null);
    }
    abort() { this.stats.aborted = true; }
    destroy() {}
    getCacheAge() { return null; }
    getResponseHeader() { return null; }
  }
  for (const previousPartMode of [true, false]) {
    const config = liveHlsConfig(1, Hls.DefaultConfig, "server");
    const hls = new Hls({ ...config, ...(previousPartMode ? { lowLatencyMode: true } : {}),
      loader: PlaylistFixtureLoader, pLoader: PlaylistFixtureLoader, autoStartLoad: false, enableWorker: false });
    const controller = hls.streamController;
    try {
      let details;
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => { details = data.details; });
      hls.on(Hls.Events.ERROR, (_event, data) => assert.fail(`Synthetic playlist failed: ${data.details}`));
      hls.loadSource(source);
      assert.equal(details.targetduration, 1);
      assert.equal(details.partTarget, 0.2);
      assert.equal(details.partHoldBack, 0.6);
      assert.equal(details.partList.length, 3);
      // No MediaSource is attached. Supply the parsed level as the controller's
      // current rendition and skip only the initial media timestamp discovery.
      const level = { details, iframes: false };
      controller.levels = [level];
      controller.levelLastLoaded = level;
      details.PTSKnown = true;
      controller.startPosition = 0;
      assert.equal(hls.targetLatency, 2, "The explicit two-segment target wins over both hold-back values");
      const fragment = controller.getNextFragment(7.3, details);
      assert.ok(fragment);
      assert.equal(controller.loadingParts, previousPartMode);
      if (previousPartMode) {
        assert.equal(fragment, details.fragmentHint, "Part mode enters the still-incomplete next fragment");
        const part = details.partList[controller.getNextPart(details.partList, fragment, 7.3)];
        assert.ok(part);
        assert.equal(part.fragment.sn, 107);
        assert.match(part.url, /\/part-107-\d\.mp4$/);
      } else {
        assert.equal(fragment, details.fragments.at(-1));
        assert.equal(fragment.sn, 106);
        assert.equal(fragment.url, "https://example.invalid/live/station/segment-106.mp4");
      }
    } finally { hls.destroy(); }
  }
});

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
  assert.equal(config.liveMaxLatencyDurationCount, 4);
  assert.ok(config.liveMaxLatencyDurationCount > config.liveSyncDurationCount);
  assert.equal(config.maxLiveSyncPlaybackRate, 1.03);
  assert.equal(config.liveSyncOnStallIncrease, 0);
  assert.equal(config.maxBufferLength, 9);
  assert.equal(config.maxMaxBufferLength, 12);
  assert.equal(config.backBufferLength, 4);
  assert.equal(config.lowLatencyMode, true);
  assert.equal(config.liveSyncMode, "buffered");
  assert.equal(config.enableWorker, true);
  assert.equal(config.liveMaxUnchangedPlaylistRefresh, 6, "Repeated HTTP-200 playlists cannot remain silently stale forever");
  for (const property of ["liveSyncDuration", "liveMaxLatencyDuration", "startLevel", "loadLevel", "currentLevel", "capLevelToPlayerSize"]) assert.equal(Object.hasOwn(config, property), false, property);
  assert.equal(config.liveSyncDurationCount * 3, 6, "Three-second segments retain a bounded client target");
  assert.equal(liveHlsConfig(1).liveSyncDurationCount, 3, "Older one-second segments retain three seconds for network jitter");
  config.maxBufferLength = 999;
  assert.equal(liveHlsConfig().maxBufferLength, 9, "Each player receives its own configuration");
});

test("native HLS resumes inside the rendition's bounded live window", () => {
  assert.equal(DEFAULT_LIVE_SEGMENT_SECONDS, 3);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100])), 94);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 1), 97);
  assert.equal(safeLiveResumeTarget(0, ranges([80, 100])), 94);
  assert.equal(safeLiveResumeTarget(1, ranges([10, 12])), 10, "A short window clamps to its safe start");
});

test("six-second rendition updates both the live target and forward buffer without rebuilding the loader", () => {
  const config=liveHlsConfig(3), loader={config,loading:true};
  Object.assign(loader.config,liveBufferTiming(6));
  assert.equal(loader.loading,true);
  assert.equal(config.liveSyncDurationCount,3);assert.equal(config.liveMaxLatencyDurationCount,6);
  assert.equal(config.maxBufferLength,24);assert.equal(config.maxMaxBufferLength,30);
  assert.equal(config.maxBufferLength,config.liveSyncDurationCount*6+6);
  assert.equal(liveHlsConfig(6).maxBufferLength,24);
});

test("relay load budgets are finite, cover both transports and clone the library's retry policies", () => {
  const defaults=Hls.DefaultConfig,config=liveHlsConfig(6,defaults);
  assert.equal(liveHlsConfig().playlistLoadPolicy,undefined,"The lightweight helper does not eagerly import the HLS runtime");
  for(const name of ["manifestLoadPolicy","playlistLoadPolicy","fragLoadPolicy"]){
    const before=defaults[name],copy=config[name];
    assert.notEqual(copy,before);assert.notEqual(copy.default,before.default);
    assert.equal(copy.default.maxTimeToFirstByteMs,50_000);
    assert.ok(Number.isFinite(copy.default.maxLoadTimeMs));
    assert.ok(copy.default.maxLoadTimeMs>=(name==="fragLoadPolicy"?120_000:60_000));
    for(const retry of ["timeoutRetry","errorRetry"]){
      assert.deepEqual(copy.default[retry],before.default[retry]);
      if(before.default[retry]!==null){
        assert.notEqual(copy.default[retry],before.default[retry]);
        const count=before.default[retry].maxNumRetry;
        copy.default[retry].maxNumRetry+=1;
        assert.equal(before.default[retry].maxNumRetry,count,"One player cannot change another player's retry budget");
      }
    }
  }
  const shouldRetry=()=>true;
  const custom={...defaults,playlistLoadPolicy:{default:{...defaults.playlistLoadPolicy.default,errorRetry:{...defaults.playlistLoadPolicy.default.errorRetry,shouldRetry}}}};
  assert.equal(liveHlsConfig(6,custom).playlistLoadPolicy.default.errorRetry.shouldRetry,shouldRetry);
});

test("the real HLS XHR loader keeps one request alive through the relay's complete fallback window", t => {
  const oldSelf=globalThis.self;
  t.after(()=>{if(oldSelf===undefined)delete globalThis.self;else globalThis.self=oldSelf;});
  const config=liveHlsConfig(6,Hls.DefaultConfig);
  for(const name of ["manifestLoadPolicy","playlistLoadPolicy","fragLoadPolicy"]){
    let now=1,sequence=0,xhr,success=0,timeouts=0;
    const timers=new Map();
    class TestXHR{
      readyState=0;status=0;aborted=false;responseURL="https://example.invalid/hls/synthetic.m3u8";responseText="#EXTM3U\n";
      constructor(){xhr=this;}
      open(){this.readyState=1;}
      send(){}
      abort(){this.aborted=true;}
      setRequestHeader(){}
    }
    globalThis.self={XMLHttpRequest:TestXHR,performance:{now:()=>now},
      setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,at:now+delay});return id;},
      clearTimeout(id){timers.delete(id);},
    };
    const loader=new Hls.DefaultConfig.loader(Hls.DefaultConfig);
    loader.load({url:"https://example.invalid/hls/synthetic.m3u8",responseType:"text",type:"level"},
      {loadPolicy:config[name].default,timeout:0,maxRetry:0,retryDelay:0,maxRetryDelay:0},
      {onSuccess(){success++;},onTimeout(){timeouts++;},onError(){assert.fail("Synthetic successful fallback cannot fail");}});
    now+=45_000;
    for(const [id,timer]of timers){if(timer.at<=now){timers.delete(id);timer.callback();}}
    assert.equal(xhr.aborted,false,`${name} cannot abort at ten seconds before the fifteen-second primary timeout`);
    assert.equal(loader.stats.retry,0);assert.equal(timeouts,0);assert.equal(success,0);
    xhr.readyState=2;xhr.onreadystatechange();
    now+=1000;xhr.status=200;xhr.readyState=4;xhr.onreadystatechange();
    assert.equal(success,1);assert.equal(timeouts,0);assert.equal(loader.stats.retry,0);assert.equal(timers.size,0);
    loader.destroy();
  }
});

test("playlist freshness identifies repeated 200 responses and producer timestamp/sequence restarts", () => {
  const details={endSN:50,lastPartSn:50,lastPartIndex:-1,fragments:[{cc:0,url:"https://example.invalid/stream-50.ts"}]};
  const before=livePlaylistKey(details);
  assert.equal(livePlaylistKey(structuredClone(details)),before,"Reloading the same body is not producer progress");
  assert.notEqual(livePlaylistKey({...details,endSN:51}),before);
  assert.notEqual(livePlaylistKey({...details,endSN:0,fragments:[{cc:1,url:"https://example.invalid/restarted-0.ts"}]}),before);
  assert.notEqual(livePlaylistKey({...details,fragments:[{cc:0,url:"https://example.invalid/restarted-50.ts"}]}),before);
  assert.equal(livePlaylistKey({...details,fragments:[]}),null);
});

test("three-second delivery keeps a six-second client target with one extra segment of headroom", () => {
  assert.equal(MOBILE_LIVE_SEGMENT_SECONDS, 3);
  const config = liveHlsConfig(3);
  assert.equal(config.liveSyncDurationCount * 3, 6);
  assert.equal(config.liveMaxLatencyDurationCount * 3, 12);
  assert.equal(config.maxBufferLength, config.liveSyncDurationCount * 3 + 3);
  assert.deepEqual(livePlaybackTiming(3), { liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 4 });
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3), 94, "Native Safari uses the same target as MSE");
  for (const time of [92, 93, 94, 97, 100]) assert.equal(safeLiveResumeTarget(time, ranges([0, 100]), 3), null);
  assert.equal(safeLiveResumeTarget(0, ranges([98, 100]), 3), 98, "Short startup windows stay inside available media");
  assert.equal(livePlaybackTiming(1).liveSyncDurationCount, 3, "An older one-second deployment still receives its existing target");
});

test("safe resume accepts a bounded HLS sync point without seeking to the last frame", () => {
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 88), 88);
  assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, 99.9), 97);
  for (const hint of [-1, 100, 1000, NaN, Infinity]) assert.equal(safeLiveResumeTarget(20, ranges([0, 100]), 3, hint), 94);
});

test("live resume never rewinds, never skips small fluctuations and chooses the latest range", () => {
  for (const time of [92, 93, 94, 95, 100, 101]) assert.equal(safeLiveResumeTarget(time, ranges([0, 100])), null, String(time));
  assert.equal(safeLiveResumeTarget(88, ranges([0, 100])), 94);
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

function installedHlsController(t, { mode = liveHlsConfig(6).liveSyncMode, buffered = [], readyState = 4, started = true, dispatchSeeking = false } = {}) {
  const hls = new Hls({ ...liveHlsConfig(6), autoStartLoad: false, enableWorker: false, liveSyncMode: mode });
  const controller = hls.streamController, seeks = [];
  let currentTime = 60, aborted = 0;
  const media = {
    duration: Infinity, readyState, seeking: false, seekable: ranges([50, 118]), buffered: ranges(...buffered),
    get currentTime() { return currentTime; },
    set currentTime(value) {
      currentTime = value; seeks.push(value);
      if (dispatchSeeking) controller.onMediaSeeking();
    },
  };
  controller.media = media;
  controller.nextLoadPosition = controller.lastCurrentTime = 60;
  controller._hasEnoughToStart = started;
  Object.defineProperty(hls, "liveSyncPosition", { value: 100, configurable: true });
  t.after(() => { controller.media = null; controller.fragCurrent = null; hls.destroy(); });
  return {
    hls, controller, media, seeks,
    synchronize() { controller.synchronizeToLiveEdge({ fragmentStart: 50, edge: 118, targetduration: 6 }); },
    downloading(start = 60) {
      const fragment = { start, duration: 6, sn: 1, loader: {}, abortRequests() { aborted++; } };
      controller.fragCurrent = fragment;
      return fragment;
    },
    get aborted() { return aborted; },
  };
}

test("the installed HLS controller preserves playable media and selects the next buffered range", t => {
  for (const mode of ["edge", "buffered"]) {
    const forward = installedHlsController(t, { mode, buffered: [[60, 66]] });
    forward.synchronize();
    assert.equal(forward.media.currentTime, mode === "buffered" ? 60 : 100,
      "Buffered synchronization must retain playable forward media when the live target is still cold");
    const next = installedHlsController(t, { mode, buffered: [[72, 78]] });
    next.synchronize();
    assert.equal(next.media.currentTime, mode === "buffered" ? 72 : 100,
      "A gap resumes at available media instead of skipping into an unbuffered live target");
  }
});

test("the installed HLS buffered mode still seeks with an empty buffer and cannot protect startup alone", t => {
  for (const mode of ["edge", "buffered"]) {
    const metadata = installedHlsController(t, { mode, readyState: 1, started: false, dispatchSeeking: true });
    metadata.downloading();
    metadata.synchronize();
    assert.equal(metadata.media.currentTime, 100);
    assert.equal(metadata.controller.nextLoadPosition, 100);
    assert.equal(metadata.aborted, 1, "Both library modes can abort the old fragment while seeking from metadata alone");
    const initial = installedHlsController(t, { mode, readyState: 0, started: false });
    initial.synchronize();
    assert.equal(initial.media.currentTime, 60, "A media element without metadata is not seeked");
    assert.equal(initial.controller.nextLoadPosition, 100, "The library still retargets its next startup load before checking the mode");
  }
});

test("MSE scroll resume keeps the current buffer and does not abort its healthy pending fragment", t => {
  const timer = fakeTimers(), fixture = installedHlsController(t, { buffered: [[60, 66]], dispatchSeeking: true });
  const fragment = fixture.downloading(66);
  const sync = createLiveResumeSync({ media: fixture.media, bufferRanges: () => fixture.media.buffered,
    liveSyncPosition: () => fixture.hls.liveSyncPosition, schedule: timer.schedule, cancel: timer.cancel });
  t.after(() => sync.dispose());
  sync.request();
  assert.deepEqual(fixture.seeks, [], "Seekable live metadata is not evidence that the target has been downloaded");
  assert.equal(fixture.media.currentTime, 60);
  assert.equal(fixture.aborted, 0);
  assert.equal(fixture.controller.fragCurrent, fragment, "The real controller keeps loading the same pending fragment");
  assert.equal(sync.pending, false);
  assert.equal(timer.size, 0);
});

test("MSE resume waits for actual forward media and catches up once when it arrives inside the retry budget", t => {
  const timer = fakeTimers(), fixture = installedHlsController(t, { readyState: 2, dispatchSeeking: true });
  fixture.downloading();
  const sync = createLiveResumeSync({ media: fixture.media, bufferRanges: () => fixture.media.buffered,
    liveSyncPosition: () => fixture.hls.liveSyncPosition, schedule: timer.schedule, cancel: timer.cancel });
  t.after(() => sync.dispose());
  sync.request();
  assert.equal(timer.fire(), true);
  assert.equal(sync.pending, true);
  assert.deepEqual(fixture.seeks, []);
  assert.equal(fixture.aborted, 0, "A decoded-ready flag without forward buffer cannot cancel an in-flight fragment");
  fixture.controller.fragCurrent = null; // The pending download has completed and appended these frames.
  fixture.media.buffered = ranges([90, 108]);
  sync.update();
  assert.deepEqual(fixture.seeks, [100]);
  assert.ok(fixture.media.currentTime >= 90 && fixture.media.currentTime < 108, "Catch-up stays strictly inside downloaded media");
  assert.equal(fixture.aborted, 0);
  assert.equal(sync.pending, false);
  assert.equal(timer.size, 0);
  fixture.media.buffered = ranges([100, 118]);
  sync.update();
  assert.deepEqual(fixture.seeks, [100], "Subsequent buffer updates cannot keep chasing the edge");
});

test("MSE resume clamps a cold live target inside short and disjoint downloaded ranges", () => {
  for (const [buffered, expected] of [[ranges([24, 27]), 24], [ranges([0, 5], [70, 90]), 84]]) {
    const timer = fakeTimers(), media = { currentTime: 0, readyState: 2, seeking: false, seekable: ranges([0, 118]), buffered };
    const sync = createLiveResumeSync({ media, bufferRanges: () => media.buffered, liveSyncPosition: () => 100,
      schedule: timer.schedule, cancel: timer.cancel });
    sync.request();
    assert.equal(media.currentTime, expected);
    const latest = latestLiveRange(media.buffered);
    assert.ok(media.currentTime >= latest.start && media.currentTime < latest.end);
    assert.equal(sync.pending, false);
    assert.equal(timer.size, 0);
    sync.dispose();
  }
});

test("MSE resume exhausts three attempts for empty, back-only or temporarily unavailable buffers", () => {
  for (const available of [() => ranges(), () => ranges([0, 20]), () => { throw new Error("Buffer changed"); }]) {
    const timer = fakeTimers(), media = { currentTime: 60, readyState: 4, seeking: false, seekable: ranges([50, 118]) };
    let buffer = available;
    const sync = createLiveResumeSync({ media, bufferRanges: () => buffer(), liveSyncPosition: () => 100,
      schedule: timer.schedule, cancel: timer.cancel });
    sync.request();
    assert.equal(timer.fire(), true);
    assert.equal(timer.fire(), true);
    assert.equal(timer.fire(), false);
    assert.equal(sync.pending, false);
    buffer = () => ranges([90, 108]);
    sync.update();
    assert.equal(media.currentTime, 60, "Late buffering cannot revive an expired synchronization request");
    sync.request();
    assert.equal(media.currentTime, 100, "A later explicit return can synchronize to the newly available buffer");
    sync.dispose();
  }
});

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

test("resume synchronizes decoded media once, not on every playlist update", () => {
  const timer = fakeTimers(), media = { currentTime: 20, seekable: ranges(), readyState: 2, seeking: false };
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

test("native/default startup playlists and repeated recovery nudges cannot seek before a decoded frame", () => {
  const timer = fakeTimers(), seeks = [];
  let currentTime = 0;
  const media = {
    readyState: 0, seeking: false, seekable: ranges(), buffered: ranges(),
    get currentTime() { return currentTime; },
    set currentTime(value) { currentTime = value; seeks.push(value); },
  };
  const sync = createLiveResumeSync({ media, schedule: timer.schedule, cancel: timer.cancel });
  for (const [index, edge] of [24, 27, 30, 33].entries()) {
    media.readyState = index % 2;
    media.seekable = ranges([0, edge]);
    sync.request();
    sync.update();
    assert.equal(timer.size, 1, "Nudges and playlist updates share one bounded retry timer");
    assert.equal(timer.fire(), true);
    assert.equal(sync.pending, false, "The third attempt expires even while the window is seekable");
    assert.equal(timer.fire(), false);
  }
  assert.deepEqual(seeks, [], "Metadata and an empty buffer cannot cancel the initial fragment by seeking");
  sync.request();
  media.readyState = 2;
  media.buffered = ranges([24, 27]);
  sync.update();
  assert.deepEqual(seeks, [27], "A decoded frame permits one bounded catch-up seek");
  assert.equal(sync.pending, false);
  assert.equal(timer.size, 0);
  media.seekable = ranges([0, 36]);
  sync.update();
  assert.deepEqual(seeks, [27], "Normal playlist updates do not restart synchronization");
  sync.request();
  assert.deepEqual(seeks, [27, 30], "An explicit later scroll resume still catches up");
  sync.dispose();
});

test("source replacement and in-flight seeks defer resume synchronization until decoded media is ready", () => {
  const timer = fakeTimers(), media = { currentTime: 20, seekable: ranges([0, 100]), readyState: 2, seeking: false };
  const sync = createLiveResumeSync({ media, schedule: timer.schedule, cancel: timer.cancel });
  sync.request();
  assert.equal(media.currentTime, 94);
  media.currentTime = 0;
  media.readyState = 0;
  media.seekable = ranges([0, 30]);
  sync.request();
  sync.update();
  assert.equal(media.currentTime, 0, "A replacement source does not inherit the previous source's decoded readiness");
  media.readyState = 2;
  media.seeking = true;
  timer.fire();
  assert.equal(media.currentTime, 0, "An existing seek is not interrupted by another synchronization");
  assert.equal(sync.pending, false);
  media.seeking = false;
  sync.request();
  assert.equal(media.currentTime, 24);
  sync.dispose();
});

test("unavailable media gets only three resume attempts and disposal cancels pending work", () => {
  const timer = fakeTimers(), media = { currentTime: 20, seekable: ranges(), readyState: 2, seeking: false };
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
  const media = { seekable: ranges([0, 100]), readyState: 2, seeking: false, get currentTime() { return 20; }, set currentTime(_value) { attempted++; throw new Error("Not seekable yet"); } };
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
  media.currentTime = 70; timer.fire(); assert.equal(media.currentTime, 97);
  media.seekable = ranges([95, 120]); timer.fire(); assert.equal(media.currentTime, 97, "A stalled connection cannot trigger repeated immediate seeks");
  now = 10_000; timer.fire(); assert.equal(media.currentTime, 117);
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
  media.seekable = ranges([75, 100]); timer.fire(); assert.equal(media.currentTime, 97);
  sync.dispose();
});

test("three-second native playback tolerates normal delivery jitter and catches excessive drift", () => {
  const timer = fakeTimers();
  const media = { currentTime: 90, seekable: ranges([75, 100]), paused: false, ended: false, seeking: false, readyState: 4 };
  const sync = createLiveDriftSync({ media, segmentSeconds: () => 3, schedule: timer.schedule, cancel: timer.cancel });
  sync.start(); timer.fire();
  assert.equal(media.currentTime, 90, "Ten seconds from the latest edge remains within the twelve-second ceiling");
  media.currentTime = 86; timer.fire();
  assert.equal(media.currentTime, 94, "Excessive drift returns to the six-second target");
  sync.dispose();
});
