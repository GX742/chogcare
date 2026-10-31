import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { POLICY, parseMasterPlaylist, parseMediaPlaylist, createState, validateState, evaluate, reserveRestart } from "../ops/stream/ingress-watchdog.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const BOOT = digest("synthetic boot"), GENERATION = digest("synthetic PID/socket");
function manifest(mediaMs, { duration = 1_000, count = 7, init = "abcdef123456_video_init.mp4", ending = "" } = {}) {
  const complete = 100 + Math.floor(mediaMs / duration);
  return ["#EXTM3U", "#EXT-X-VERSION:9", "#EXT-X-TARGETDURATION:1",
    `#EXT-X-MEDIA-SEQUENCE:${complete - count}`, `#EXT-X-MAP:URI="${init}"`,
    ...Array.from({ length: count }, (_, index) => [
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-31T00:00:00.000Z",
      `#EXTINF:${duration / 1_000},`, `abcdef123456_video_seg${complete - count + index}.mp4`,
    ]).flat(), '#EXT-X-PART:DURATION=0.200,URI="abcdef123456_video_part999.mp4",INDEPENDENT=YES',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="abcdef123456_video_part1000.mp4"', ending, ""].join("\n");
}
const parsed = (mediaMs, options) => parseMediaPlaylist(manifest(mediaMs, options));
const observation = (nowMs, mediaMs, options = {}) => ({ nowMs, bootId: BOOT, valid: true, safe: true,
  generation: GENERATION, playlist: parsed(mediaMs, options), ...options });
function simulate(mediaAt, { until = 200_000, reserve = false, options = {} } = {}) {
  let state = createState(BOOT, 0);
  const results = [];
  for (let now = 0; now <= until; now += POLICY.pollMs) {
    // Each poll models a new systemd oneshot with disk JSON, not process memory.
    const result = evaluate(JSON.parse(JSON.stringify(state)), observation(now, mediaAt(now), options));
    state = result.state;
    if (result.action && reserve) state = reserveRestart(state, result.action, now);
    results.push({ now, ...result });
  }
  return { state, results, actions: results.filter(result => result.action) };
}

test("strict parser selects the video master child and counts only completed fractional EXTINF", () => {
  assert.equal(parseMasterPlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="audio"\nvideo.m3u8\n'), "video.m3u8");
  const result = parsed(1_000, { duration: 500 });
  assert.equal(result.eligible, true);
  assert.equal(result.segments.length, 7);
  assert.equal(result.segments[0].durationMs, 500);
  assert.match(result.initId, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("2026"), false);
  for (const invalid of ["../video.m3u8", "https://example.invalid/video.m3u8", "video.m3u8?token=x"]) {
    assert.throws(() => parseMasterPlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${invalid}\n`));
  }
  assert.throws(() => parseMasterPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n"));
});

test("ENDLIST/GAP/discontinuity/skip/encryption and malformed rows are ineligible", () => {
  for (const ending of ["#EXT-X-ENDLIST", "#EXT-X-GAP", "#EXT-X-DISCONTINUITY", "#EXT-X-DISCONTINUITY-SEQUENCE:1", "#EXT-X-SKIP:SKIPPED-SEGMENTS=1", '#EXT-X-KEY:METHOD=AES-128,URI="key"']) {
    assert.equal(parsed(0, { ending }).eligible, false, ending);
  }
  for (const text of [manifest(0).replace("#EXTINF:1,", "#EXTINF:NaN,"), manifest(0) + "#EXTINF:1,\n",
    manifest(0).replace("_seg93.mp4", "_seg93.mp4?x=y"), manifest(0).replace("#EXT-X-MEDIA-SEQUENCE:93", "#EXT-X-MEDIA-SEQUENCE:-1"),
    manifest(0).replace("_seg94.mp4", "_seg93.mp4"),
    manifest(0).replace("#EXT-X-MEDIA-SEQUENCE:93", "#EXT-X-MEDIA-SEQUENCE:93\n#EXT-X-MEDIA-SEQUENCE:93"), "x".repeat(65_537)]) {
    assert.equal(parseMediaPlaylist(text).eligible, false);
  }
});

test("healthy 1x delivery and wall clock jumps cannot request recovery", () => {
  const healthy = simulate(now => now, { until: 240_000 });
  assert.equal(healthy.actions.length, 0);
  assert.ok(healthy.state.healthyAnchor);
  // The engine accepts no wall clock/PDT input. Changing both has no effect.
  let state = createState(BOOT, 0);
  for (let now = 0; now <= 120_000; now += 5_000) {
    const sample = observation(now, now);
    sample.wallClockMs = now % 10_000 ? 0 : 9e15;
    sample.playlist = parseMediaPlaylist(manifest(now).replaceAll("2026-10-31", now % 10_000 ? "1999-01-01" : "2099-01-01"));
    const result = evaluate(state, sample); state = result.state;
    assert.equal(result.action, null);
  }
});

test("completed fractional timelines and normal jitter/burst arrivals remain healthy", () => {
  assert.equal(simulate(now => now, { until: 180_000, options: { duration: 500, count: 20 } }).actions.length, 0);
  const jitter = simulate(now => Math.floor(now / 10_000) * 10_000, { until: 240_000, options: { count: 20 } });
  assert.equal(jitter.actions.length, 0);
});

test("previously healthy severe slowdown requires startup grace and confirmed observation", () => {
  const result = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) / 4, { until: 100_000 });
  assert.ok(result.actions.length > 0);
  assert.ok(result.actions.every(action => action.now >= 65_000));
  assert.equal(result.actions[0].action.reason, "slow_timeline");
});

test("0.7x accumulates timeline deficit and is recovered after healthy anchor", () => {
  const result = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) * 0.7, { until: 150_000 });
  assert.ok(result.actions.length > 0);
  assert.equal(result.actions[0].action.reason, "cumulative_deficit");
  assert.ok(result.actions[0].now >= 80_000);
  assert.ok(result.actions[0].now <= 120_000);
});

test("a latest recovery burst cancels a pending action instead of restarting recovering source", () => {
  const result = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) / 4, { until: 60_000 });
  assert.ok(result.state.pending);
  const edge = result.state.last.edgeMs;
  const lastMedia = 30_000 + 30_000 / 4;
  const recovered = evaluate(result.state, observation(65_000, lastMedia + 5_000));
  assert.equal(recovered.action, null);
  assert.equal(recovered.state.pending, null);
  assert.ok(recovered.state.last.edgeMs >= edge + 5_000);
});

test("never-healthy startup requires 120s grace plus a complete 60s slow window", () => {
  const result = simulate(now => now / 4, { until: 200_000 });
  assert.ok(result.actions.length > 0);
  assert.ok(result.actions[0].now >= 180_000);
  assert.equal(result.actions[0].action.reason, "initial_slow_timeline");
  assert.equal(simulate(() => 0, { until: 175_000 }).actions.length, 0);
  const moderate = simulate(now => now * 0.7, { until: 200_000 });
  assert.ok(moderate.actions.length > 0);
  assert.equal(moderate.actions[0].action.reason, "initial_slow_timeline");
  assert.ok(moderate.actions[0].now >= 180_000);
  assert.equal(simulate(now => Math.max(0, now - 30_000), { until: 240_000 }).actions.length, 0);
});

test("invalid HTTP/auth/no publisher/manual stop and unsafe runtime never restart", () => {
  for (const override of [{ valid: false }, { safe: false }, { playlist: { eligible: false, reason: "malformed_playlist" } }]) {
    const result = simulate(() => 0, { until: 240_000, options: override });
    assert.equal(result.actions.length, 0);
    assert.equal(result.state.healthyAnchor, null);
  }
});

test("no overlap, sequence rollback, changed URI/duration, muxer or socket generation reset evidence", () => {
  const base = simulate(now => now, { until: 60_000 }).state;
  const cases = [observation(65_000, 100_000), observation(65_000, 0),
    observation(65_000, 65_000, { init: "different_video_init.mp4" }),
    { ...observation(65_000, 65_000), generation: digest("new socket") }];
  for (const sample of cases) {
    const result = evaluate(base, sample);
    assert.equal(result.action, null);
    assert.equal(result.state.healthyAnchor, null);
    assert.equal(result.state.startedAtMs, 65_000);
  }
  for (const field of ["id", "durationMs"]) {
    const sample = observation(65_000, 65_000);
    sample.playlist.segments[0][field] = field === "id" ? digest("replacement URI") : 2_000;
    assert.equal(evaluate(base, sample).status, "warming");
  }
  assert.equal(evaluate(base, observation(75_000, 75_000)).status, "warming");
});

test("restart intent persists before execution; unknown result and new generation consume budget", () => {
  const first = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) / 4, { until: 100_000 }).actions[0];
  let state = reserveRestart(first.state, first.action, first.now);
  state = validateState(JSON.parse(JSON.stringify(state)), BOOT, first.now);
  assert.deepEqual(state.intents, [first.now]);
  assert.throws(() => reserveRestart(state, first.action, first.now));
  state = evaluate(state, { ...observation(first.now + 5_000, 0), generation: digest("replacement") }).state;
  assert.deepEqual(state.intents, [first.now]);
});

test("fresh failure or recovered cadence cancels a mature recommendation before reservation", () => {
  const first = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) * 0.7, { until: 150_000 }).actions[0];
  for (const override of [{ valid: false }, { safe: false }, { playlist: { eligible: false, reason: "unsupported_timeline" } }]) {
    const final = evaluate(first.state, { ...observation(first.now + 1, 0), ...override });
    assert.equal(final.action, null);
    assert.equal(final.state.pending, null);
    assert.throws(() => reserveRestart(final.state, first.action, first.now + 1));
  }
  const mediaAtFirst = 30_000 + (first.now - 30_000) * 0.7;
  const final = evaluate(first.state, observation(first.now + 5_000, mediaAtFirst + 5_000));
  assert.equal(final.action, null);
  assert.equal(final.state.pending, null);
});

test("persistent rolling budget permits at most one per five minutes and two per hour", () => {
  const result = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) / 4, { until: 3_800_000, reserve: true });
  const times = result.actions.map(action => action.now);
  assert.ok(times.length >= 3);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 300_000);
  for (const now of times) assert.ok(times.filter(at => at <= now && now - at < 3_600_000).length <= 2);
});

test("boot change discards observation but retains ambiguous restart budget for a new full hour", () => {
  const first = simulate(now => now <= 30_000 ? now : 30_000 + (now - 30_000) / 4, { until: 100_000 }).actions[0];
  const state = reserveRestart(first.state, first.action, first.now);
  const changed = validateState(state, digest("new boot"), 1_000);
  assert.equal(changed.last, null);
  assert.deepEqual(changed.intents, [1_000]);
  assert.equal(changed.bootId, digest("new boot"));
});

test("corrupt state, reversed monotonic clock and oversized persistence fail closed", () => {
  const state = simulate(now => now, { until: 30_000 }).state;
  assert.throws(() => validateState(state, BOOT, 29_999));
  for (const corrupt of [null, { ...state, version: 2 }, { ...state, intents: [-1] },
    { ...state, unrecognized: true }, { ...state, healthyAnchor: { atMs: 99_999, edgeMs: 0 } },
    { ...state, history: [...state.history].reverse() }, { ...state, last: { ...state.last, playlist: {} } },
    { ...state, padding: "x".repeat(POLICY.maxStateBytes) }]) assert.throws(() => validateState(corrupt, BOOT, 30_000));
});

test("already delayed 1x input is intentionally not an absolute camera latency detector", () => {
  const result = simulate(now => now, { until: 180_000 });
  assert.equal(result.actions.length, 0);
  // No trusted camera clock exists here; a 1x delayed stream has the same data.
});
