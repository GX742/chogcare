import test from "node:test";
import assert from "node:assert/strict";
import { createLivePlaybackRecovery } from "../src/live-recovery.ts";
import { createLiveLoadState } from "../src/live-player.ts";
import { createLiveViewportPresence } from "../src/live-viewport.ts";

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

function playerFixture({frameDriven=false,transport="relay"}={}) {
  const clock = fakeClock(), states = [], calls = { play: [], load: [], catchUp: [], reconnect: [], playing: [], waiting: [], transfer: [] };
  let active = true, playBehavior, reconnectBehavior, transfer=null;
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
    frameDriven, transport, transferProgress:()=>{calls.transfer.push(clock.now());return transfer;},
    resumeLoading(catchUp = false) { calls.load.push(clock.now()); calls.catchUp.push(catchUp); },
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
    setTransfer(value) { transfer=value; },
    async start() { recovery.play(); await flushPromises(); recovery.playing(); },
    dispose() { recovery.dispose(); monitor.dispose(); },
  };
}

function viewportPlayerFixture() {
  const clock = fakeClock(), frames = new Map();
  const calls = { resume: [], suspend: [], reconnect: [], presence: [], play: [] };
  let geometry = true, observable = true, inViewport = false, disposed = false, nextFrame = 0;
  const media = {
    currentTime: 10, paused: true, ended: false, seeking: false, readyState: 4,
    play() { calls.play.push(clock.now()); media.paused = false; return Promise.resolve(); },
  };
  const monitor = createLiveLoadState({ onChange() {}, schedule: clock.schedule, cancel: clock.cancel });
  const recovery = createLivePlaybackRecovery({
    media, active: () => !disposed && observable && geometry && inViewport, monitor,
    frameDriven: true, transport: "server", resumeLoading() {},
    reconnect() { calls.reconnect.push(clock.now()); }, onPlaying() {}, onWaiting() {},
    onSuspend() {
      calls.suspend.push(clock.now());
      if (disposed || !inViewport) return;
      presence.suspend();
      presence.invalidate();
    },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  const presence = createLiveViewportPresence({
    read: () => !disposed && observable && geometry,
    onChange(visible) {
      inViewport = visible; calls.presence.push(visible);
      if (visible) { calls.resume.push(clock.now()); recovery.resume(); }
      else recovery.suspend();
    },
    schedule(callback) { const frame = ++nextFrame; frames.set(frame, callback); return frame; },
    cancel(frame) { frames.delete(frame); },
  });
  const flushPresence = async () => {
    const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback());
    await flushPromises();
  };
  return {
    clock, calls, media, monitor, recovery, presence, flushPresence,
    setGeometry(value) { geometry = value; },
    setObservable(value) { observable = value; },
    get pendingFrames() { return frames.size; },
    async start() {
      presence.invalidate(); recovery.waiting(); await flushPresence();
      media.currentTime = 11; recovery.frame(11);
    },
    dispose() { disposed = true; presence.dispose(); recovery.dispose(); monitor.dispose(); },
  };
}

test("an inactive health tick reconciles cached visibility and resumes after a transient geometry gap", async () => {
  const fixture = viewportPlayerFixture();
  await fixture.start();
  fixture.setGeometry(false); fixture.presence.invalidate();
  await fixture.clock.advance(1000);
  assert.deepEqual(fixture.calls.presence, [true, false]);
  assert.equal(fixture.clock.size, 0);
  assert.equal(fixture.pendingFrames, 1, "The discarded geometry sample is replaced with one fresh sample");
  assert.deepEqual(fixture.calls.suspend, [0, 1000], "The nested viewport suspension notifies only once");
  fixture.setGeometry(true); fixture.media.readyState = 2;
  await fixture.flushPresence();
  assert.deepEqual(fixture.calls.presence, [true, false, true]);
  assert.deepEqual(fixture.calls.resume, [0, 1000]);
  await fixture.clock.advance(7000);
  assert.deepEqual(fixture.calls.reconnect, [8000], "A frozen returned video reconnects without a click or another observer event");
  assert.ok(fixture.clock.maximumPending <= 3);
  fixture.dispose();
});

test("startup suspension preserves the first viewport sample without an observer or scroll event", async () => {
  const fixture = viewportPlayerFixture();
  fixture.presence.invalidate(); fixture.recovery.waiting();
  assert.equal(fixture.pendingFrames, 1);
  await fixture.flushPresence();
  assert.deepEqual(fixture.calls.resume, [0]);
  assert.equal(fixture.calls.play.length, 1);
  assert.ok(fixture.clock.size > 0);
  fixture.media.currentTime = 11; fixture.recovery.frame(11);
  assert.equal(fixture.monitor.state, "playing");
  fixture.dispose();
});

test("unchanged visible samples do not reset a stalled player's recovery deadline", async () => {
  const fixture = viewportPlayerFixture();
  await fixture.start(); fixture.media.readyState = 2;
  for (let second = 0; second < 7; second++) {
    fixture.presence.invalidate(); await fixture.flushPresence(); await fixture.clock.advance(1000);
  }
  assert.deepEqual(fixture.calls.resume, [0]);
  assert.deepEqual(fixture.calls.reconnect, [7000]);
  fixture.dispose();
});

test("explicit hidden or offline suspension stays idle overnight and resumes once", async () => {
  const fixture = viewportPlayerFixture();
  await fixture.start(); fixture.setObservable(false); fixture.presence.suspend();
  for (let index = 0; index < 20; index++) { fixture.recovery.waiting(); fixture.recovery.paused(); }
  assert.equal(fixture.pendingFrames, 0);
  await fixture.clock.advance(9 * 60 * 60 * 1000);
  assert.equal(fixture.clock.size, 0);
  assert.deepEqual(fixture.calls.reconnect, []);
  fixture.setObservable(true); fixture.media.readyState = 2; fixture.presence.invalidate();
  await fixture.flushPresence();
  assert.equal(fixture.calls.resume.length, 2);
  await fixture.clock.advance(7000);
  assert.equal(fixture.calls.reconnect.length, 1);
  fixture.dispose();
});

test("disposal cancels geometry reconciliation and cannot notify or resume a removed player", async () => {
  const fixture = viewportPlayerFixture();
  await fixture.start(); fixture.setGeometry(false); await fixture.clock.advance(1000);
  assert.equal(fixture.pendingFrames, 1);
  fixture.dispose(); const snapshot = structuredClone(fixture.calls);
  fixture.setGeometry(true); fixture.presence.invalidate(); fixture.recovery.suspend(); fixture.recovery.waiting();
  await fixture.flushPresence(); await fixture.clock.advance(60000);
  assert.equal(fixture.pendingFrames, 0); assert.equal(fixture.clock.size, 0);
  assert.deepEqual(fixture.calls, snapshot);
});

test("server delivery rebuilds a frozen player after six seconds instead of the relay's long failover window", async () => {
  const fixture = playerFixture({ frameDriven: true, transport: "server" });
  await fixture.start();
  fixture.recovery.frame(11);
  fixture.recovery.waiting();
  await fixture.clock.advance(5999);
  assert.equal(fixture.calls.reconnect.length, 0);
  await fixture.clock.advance(1001);
  assert.deepEqual(fixture.calls.reconnect, [7000]);
  fixture.dispose();
});

test("a server source without its first frame has a twelve-second startup deadline", async () => {
  const fixture = playerFixture({ frameDriven: true, transport: "server" });
  await fixture.start();
  await fixture.clock.advance(11_999);
  assert.equal(fixture.calls.reconnect.length, 0);
  await fixture.clock.advance(1001);
  assert.deepEqual(fixture.calls.reconnect, [13_000]);
  fixture.dispose();
});

test("server request churn cannot extend a frozen decoder beyond the hard deadline", async () => {
  const fixture = playerFixture({ frameDriven: true, transport: "server" });
  await fixture.start();
  fixture.recovery.frame(11);
  for (let index=0; index<23; index++) {
    fixture.setTransfer({ request: {}, loaded: index+1 });
    fixture.recovery.receivedData(1);
    await fixture.clock.advance(1000);
  }
  assert.equal(fixture.calls.reconnect.length, 0, "Useful transfers get a bounded chance to finish");
  fixture.setTransfer({ request: {}, loaded: 1 });
  await fixture.clock.advance(2000);
  assert.deepEqual(fixture.calls.reconnect, [25_000], "Only decoded progress resets the hard deadline");
  fixture.dispose();
});

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
  await fixture.clock.advance(40_999);
  assert.equal(fixture.calls.reconnect.length, 0, "The established stall deadline has not elapsed before forty-five seconds");
  await fixture.clock.advance(1);
  assert.equal(fixture.calls.reconnect.length, 0, "Reaching the finite deadline still respects recovery backoff");
  await fixture.clock.advance(999);
  assert.equal(fixture.calls.reconnect.length, 0, "A reconnect retains a bounded backoff");
  await fixture.clock.advance(1);
  assert.equal(fixture.calls.reconnect.length, 1, "Persistent lack of progress triggers a real reconnect");
  assert.equal(fixture.states.includes("blocked"), false);
  fixture.dispose();
});

test("a stale HTTP-200 playlist recovers after frames stop without aborting buffered healthy playback", async () => {
  const fixture=playerFixture();await fixture.start();
  fixture.recovery.playlistStalled();
  for(let index=0;index<15;index++){
    fixture.media.currentTime+=1;fixture.recovery.progress();await fixture.clock.advance(1000);
  }
  assert.equal(fixture.calls.reconnect.length,0,"A stale playlist does not discard still-playing buffered media");
  await fixture.clock.advance(4000);
  assert.equal(fixture.calls.reconnect.length,1,"Once frames stop, the known stale playlist uses bounded fast recovery");
  fixture.dispose();
});

test("an advancing or restarted producer clears stale-playlist state without fabricating a decoded frame", async () => {
  const fixture=playerFixture();await fixture.start();
  fixture.recovery.playlistStalled();await fixture.clock.advance(2000);
  const frames=fixture.calls.playing.length;
  fixture.recovery.playlistAdvanced();
  await fixture.clock.advance(40_000);
  assert.equal(fixture.calls.reconnect.length,0,"A changed producer snapshot clears the early stale recovery");
  assert.equal(fixture.calls.playing.length,frames,"New playlist metadata does not prove video playback");
  await fixture.clock.advance(4000);
  assert.equal(fixture.calls.reconnect.length,1,"A decoder still frozen behind a healthy producer retains its finite watchdog");
  fixture.dispose();
});

test("growing fragment bytes protect a useful slow download while a stuck counter cannot postpone recovery", async () => {
  const fixture=playerFixture(),request={};await fixture.start();fixture.recovery.waiting();
  for(let index=1;index<=16;index++){
    fixture.setTransfer({request,loaded:index*1000});await fixture.clock.advance(5000);
  }
  assert.equal(fixture.calls.reconnect.length,0,"Eighty seconds of real received bytes must not abort the fragment at forty-five seconds");
  fixture.setTransfer(null);fixture.media.currentTime+=.25;fixture.recovery.progress();
  assert.equal(fixture.monitor.state,"playing");fixture.dispose();

  const stuck=playerFixture();await stuck.start();stuck.setTransfer({request:{},loaded:1000});
  await stuck.clock.advance(46_000);
  assert.equal(stuck.calls.reconnect.length,1,"A single old byte count is not continuing network progress");
  stuck.dispose();
});

test("an endless byte trickle without decoded frames still reaches the hard recovery deadline", async () => {
  const fixture=playerFixture(),request={};await fixture.start();
  for(let index=1;index<=24;index++){
    fixture.setTransfer({request,loaded:index});await fixture.clock.advance(5000);
  }
  await fixture.clock.advance(1000);
  assert.equal(fixture.calls.reconnect.length,1,"Actual byte progress cannot disable the two-minute hard ceiling");
  fixture.dispose();
});

test("a pending first-byte request gets the relay's fifty-second budget without changing generic stall recovery", async () => {
  for(const stale of [false,true]){
    const fixture=playerFixture();await fixture.start();fixture.setTransfer({request:{},loaded:0});
    if(stale)fixture.recovery.playlistStalled();
    await fixture.clock.advance(46_000);
    assert.equal(fixture.calls.reconnect.length,0,"A real pending relay request must survive the former forty-five-second watchdog");
    for(let index=0;index<4;index++){
      fixture.recovery.waiting();await fixture.clock.advance(1000);
    }
    assert.equal(fixture.calls.reconnect.length,0,"Repeated waiting cannot reset or shorten the first-byte budget");
    await fixture.clock.advance(2000);
    assert.deepEqual(fixture.calls.reconnect,[52_000],"First health observation adds at most one tick, followed by normal recovery backoff");
    fixture.dispose();
  }
  const generic=playerFixture();await generic.start();await generic.clock.advance(46_000);
  assert.deepEqual(generic.calls.reconnect,[46_000],"A player without an actual pending request keeps its existing recovery deadline");
  generic.dispose();
});

test("new zero-byte requests cannot keep extending the overall hard recovery ceiling", async () => {
  const fixture=playerFixture();await fixture.start();
  for(let index=0;index<24;index++){
    fixture.setTransfer({request:{},loaded:0});fixture.recovery.waiting();
    fixture.recovery.playlistAdvanced();await fixture.clock.advance(5000);
  }
  await fixture.clock.advance(1000);
  assert.deepEqual(fixture.calls.reconnect,[121_000],"Retry/request identities and playlist events cannot postpone the hard ceiling");
  fixture.dispose();
});

test("a pending playlist grants only first-byte grace and completion/error removes that grace without fabricating frames", async () => {
  for(const outcome of ["loaded","nonfatal-error"]){
    const fixture=playerFixture();await fixture.start();
    const playlist={kind:"playlist",loaded:0},frames=fixture.calls.playing.length;
    fixture.setTransfer({request:playlist,loaded:0});
    await fixture.clock.advance(46_000);
    assert.equal(fixture.calls.reconnect.length,0,"A playlist request can finish relay failover after the generic stall deadline");
    assert.equal(fixture.calls.playing.length,frames,"Synthetic playlist metadata cannot invent bytes or decoded video");
    fixture.setTransfer(null); // LEVEL_LOADED or its matching nonfatal load error.
    await fixture.clock.advance(2000);
    assert.equal(fixture.calls.reconnect.length,1,`${outcome} must release pending-request grace if the video remains frozen`);
    assert.equal(fixture.calls.playing.length,frames);
    fixture.dispose();
  }
});

test("a fragment completing between watchdog ticks gets a short decode grace without inventing playback", async () => {
  const fixture=playerFixture();await fixture.start();
  await fixture.clock.advance(44_900);
  const frames=fixture.calls.playing.length;
  fixture.recovery.receivedData(1000);
  await fixture.clock.advance(3000);
  assert.equal(fixture.calls.reconnect.length,0,"A newly completed download must be allowed to reach the decoder");
  assert.equal(fixture.calls.playing.length,frames);
  fixture.media.currentTime+=.25;fixture.recovery.progress();
  assert.equal(fixture.monitor.state,"playing");fixture.dispose();
});

test("repeated active resume notifications cannot extend an established freeze forever", async () => {
  const fixture=playerFixture();await fixture.start();
  for(let index=0;index<9;index++){
    fixture.recovery.resume();await fixture.clock.advance(5000);
  }
  await fixture.clock.advance(1000);
  assert.equal(fixture.calls.reconnect.length,1,"Only a genuine suspension may rebase the resumed playback deadline");
  fixture.dispose();
});

test("frame-capable browsers require decoded video progress rather than play promises or advancing audio time", async () => {
  const fixture=playerFixture({frameDriven:true});await fixture.start();
  assert.equal(fixture.calls.playing.length,0);
  fixture.media.currentTime+=1;fixture.recovery.progress();
  assert.equal(fixture.calls.playing.length,0,"A timeupdate alone cannot turn LIVE on");
  fixture.recovery.frame(fixture.media.currentTime);
  assert.equal(fixture.calls.playing.length,1);assert.equal(fixture.monitor.state,"playing");
  for(let index=0;index<46;index++){
    fixture.media.currentTime+=1;fixture.recovery.progress();await fixture.clock.advance(1000);
  }
  assert.equal(fixture.calls.reconnect.length,1,"An advancing media clock cannot mask a frozen video decoder");
  fixture.dispose();
});

test("hidden or disposed players stop polling byte progress and ignore late decoded-frame callbacks", async () => {
  const fixture=playerFixture({frameDriven:true});await fixture.start();
  fixture.media.currentTime+=1;fixture.recovery.frame(fixture.media.currentTime);
  fixture.setTransfer({request:{},loaded:1000});await fixture.clock.advance(1000);
  fixture.setActive(false);fixture.recovery.suspend();
  const frames=fixture.calls.playing.length,polls=fixture.calls.transfer.length;
  fixture.media.currentTime+=1;fixture.recovery.frame(fixture.media.currentTime);
  fixture.recovery.receivedData(2000);fixture.recovery.playlistStalled();
  await fixture.clock.advance(90_000);
  assert.equal(fixture.calls.playing.length,frames);assert.equal(fixture.calls.transfer.length,polls);
  assert.equal(fixture.clock.size,0);
  fixture.dispose();fixture.setActive(true);
  fixture.recovery.frame(fixture.media.currentTime+1);fixture.recovery.receivedData(3000);
  fixture.recovery.playlistAdvanced();fixture.recovery.playlistStalled();
  await fixture.clock.advance(90_000);
  assert.equal(fixture.calls.playing.length,frames);assert.equal(fixture.calls.transfer.length,polls);
  assert.equal(fixture.clock.size,0);
});

test("a playlist retry followed by a thirty-four-second segment load can finish without a watchdog rebuild", async () => {
  const fixture = playerFixture();
  let fragmentCompletion, completed = 0;
  fixture.setReconnectBehavior(() => fixture.clock.cancel(fragmentCompletion));
  await fixture.start();
  const healthyEvents = fixture.calls.playing.length;
  fixture.media.readyState = 2;
  fixture.recovery.waiting();
  fixture.clock.schedule(() => {
    fragmentCompletion = fixture.clock.schedule(() => {
      completed++;
      fixture.media.currentTime += .25;
      fixture.recovery.progress();
    }, 34_000);
  }, 10_000);
  await fixture.clock.advance(43_999);
  assert.equal(completed, 0);
  assert.equal(fixture.calls.reconnect.length, 0, "A playlist timeout and slow segment retain the original engine");
  assert.equal(fixture.calls.playing.length, healthyEvents, "The stalled playhead must not fabricate healthy progress");
  assert.ok(fixture.calls.catchUp.length > 1);
  assert.ok(fixture.calls.catchUp.every(value => value === false), "Repeated watchdog nudges must not request catch-up seeks");
  await fixture.clock.advance(1);
  assert.equal(completed, 1, "The original fragment load was not cancelled by watchdog recovery");
  assert.equal(fixture.monitor.state, "playing");
  for (let index = 0; index < 5; index++) {
    await fixture.clock.advance(1000);
    fixture.media.currentTime += 1;
    fixture.recovery.progress();
  }
  assert.equal(fixture.calls.reconnect.length, 0, "Fresh frames cancel stale recovery and reset the stall clock");
  fixture.dispose();
});

test("only an explicit viewport or online resume requests catch-up synchronization", async () => {
  const fixture = playerFixture();
  await fixture.start();
  await fixture.clock.advance(10_000);
  assert.deepEqual(fixture.calls.catchUp, [false, false, false]);
  fixture.setActive(false);
  fixture.recovery.suspend();
  await fixture.clock.advance(20_000);
  assert.deepEqual(fixture.calls.catchUp, [false, false, false], "Suspension cancels background nudges");
  fixture.setActive(true);
  fixture.recovery.resume();
  await flushPromises();
  assert.deepEqual(fixture.calls.catchUp, [false, false, false, true]);
  fixture.dispose();
});

test("a slow initial load completes before any rebuild, then uses the normal playback stall budget", async () => {
  const fixture = playerFixture();
  fixture.media.readyState = 0;
  let firstFrames = 0;
  const completion = fixture.clock.schedule(() => {
    firstFrames++;
    fixture.media.readyState = 2;
    fixture.media.currentTime += .25;
    fixture.recovery.progress();
  }, 24_000);
  // Rebuilding the actual HLS engine aborts its pending first-fragment request.
  fixture.setReconnectBehavior(() => fixture.clock.cancel(completion));
  await fixture.start();
  await fixture.clock.advance(23_999);
  assert.equal(fixture.calls.reconnect.length, 0, "The initial loader must retain its full first-frame budget");
  assert.equal(fixture.calls.playing.length, 0, "A resolved play promise without a decoded frame is not startup proof");
  await fixture.clock.advance(1);
  assert.equal(firstFrames, 1, "The original slow load delivers its first decoded frame");
  assert.equal(fixture.monitor.state, "playing");
  await fixture.clock.advance(45_999);
  assert.equal(fixture.calls.reconnect.length, 0);
  await fixture.clock.advance(1);
  assert.equal(fixture.calls.reconnect.length, 1, "Playback freezes still recover with the finite stall deadline and backoff");
  fixture.dispose();
});

test("an initial load has a finite deadline that waiting, seeks and repeated active resumes cannot extend", async () => {
  const fixture = playerFixture();
  fixture.media.readyState = 0;
  await fixture.start();
  for (let index = 0; index < 11; index++) {
    await fixture.clock.advance(5000);
    fixture.media.currentTime += 100;
    fixture.media.seeking = true;
    fixture.media.readyState = 1;
    fixture.recovery.progress();
    fixture.recovery.playing();
    fixture.media.seeking = false;
    fixture.media.readyState = 0;
    fixture.recovery.waiting();
    fixture.recovery.resume();
  }
  await fixture.clock.advance(4999);
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.calls.playing.length, 0, "Seek-generated time updates and metadata are not decoded frames");
  assert.equal(fixture.monitor.state, "unavailable", "The UI watchdog stays finite while the original load continues");
  await fixture.clock.advance(1001);
  assert.deepEqual(fixture.calls.reconnect, [61_000], "A never-completing initial load rebuilds after sixty seconds plus bounded backoff");
  fixture.dispose();
});

test("a resolved play promise alone cannot shorten startup before a decoded playing event", async () => {
  const fixture = playerFixture();
  fixture.media.readyState = 3;
  fixture.recovery.play();
  await flushPromises();
  await fixture.clock.advance(24_000);
  assert.equal(fixture.calls.reconnect.length, 0, "Resolving play without advancing or a playing event is not first-frame proof");
  fixture.media.readyState = 1;
  fixture.recovery.playing();
  await fixture.clock.advance(1000);
  assert.equal(fixture.calls.reconnect.length, 0);
  fixture.media.readyState = 2;
  fixture.recovery.playing();
  await fixture.clock.advance(46_000);
  assert.equal(fixture.calls.reconnect.length, 1, "A decoded playing event activates the normal stall budget");
  fixture.dispose();
});

test("a genuinely suspended initial load gets a fresh startup deadline once it resumes", async () => {
  const fixture = playerFixture();
  fixture.media.readyState = 0;
  await fixture.start();
  await fixture.clock.advance(20_000);
  fixture.setActive(false);
  fixture.media.paused = true;
  fixture.recovery.suspend();
  await fixture.clock.advance(90_000);
  assert.equal(fixture.calls.reconnect.length, 0);
  assert.equal(fixture.clock.size, 0);
  fixture.setActive(true);
  fixture.recovery.resume();
  await fixture.clock.advance(59_999);
  assert.equal(fixture.calls.reconnect.length, 0, "Time hidden or offline must not consume the resumed initial-load budget");
  await fixture.clock.advance(1001);
  assert.deepEqual(fixture.calls.reconnect, [171_000]);
  fixture.dispose();
});

test("replacing a previously playing source restores the full bounded first-frame budget", async () => {
  const fixture = playerFixture();
  await fixture.start();
  await fixture.clock.advance(1000);
  fixture.media.readyState = 0;
  fixture.media.currentTime = 0;
  fixture.recovery.resetSource();
  fixture.recovery.waiting();
  await fixture.clock.advance(59_999);
  assert.equal(fixture.calls.reconnect.length, 0, "A replacement source cannot inherit the old source's established-playback deadline");
  await fixture.clock.advance(1001);
  assert.deepEqual(fixture.calls.reconnect, [62_000]);
  fixture.dispose();
});

test("a fatal loader failure during startup repairs immediately without waiting for the first-frame deadline", async () => {
  const fixture = playerFixture(), repairs = [];
  fixture.media.readyState = 0;
  await fixture.start();
  fixture.recovery.recover(() => repairs.push(fixture.clock.now()), true);
  await fixture.clock.advance(999);
  assert.deepEqual(repairs, []);
  await fixture.clock.advance(1);
  assert.deepEqual(repairs, [1000], "Fatal loader repair keeps its existing bounded backoff");
  assert.equal(fixture.calls.reconnect.length, 0);
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
