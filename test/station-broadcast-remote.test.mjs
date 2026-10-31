import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteBroadcastFreshness } from "../scripts/station-broadcast-remote.mjs";

const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8\n";
const media = (sequence, part, epoch = "init") => `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-MAP:URI="${epoch}.mp4"\n#EXT-X-PART:DURATION=0.3,URI="part${part}.mp4"\n`;
const root = "https://45.38.60.159/live/station/";

test("remote station video requires observed advancement and frozen 200 playlists expire finitely", async () => {
  let clock = 0, body = media(1, 1); const calls = [];
  const status = createRemoteBroadcastFreshness({ now: () => clock, fetcher: async (url, options) => { calls.push({ url, options }); return new Response(url.endsWith("index.m3u8") ? master : body); } });
  assert.equal(await status.check(), false); body = media(1, 2); clock = 1000;
  assert.equal(await status.check(), true); assert.equal(status.live, true);
  clock = 10000; assert.equal(await status.check(), true);
  clock = 16000; assert.equal(await status.check(), false); assert.equal(status.live, false);
  assert.ok(calls.every(call => [root + "index.m3u8", root + "video.m3u8"].includes(call.url)));
  assert.ok(calls.every(call => call.options.credentials === "omit" && call.options.redirect === "error" && call.options.cache === "no-store" && Object.keys(call.options.headers).join(",") === "Accept"));
  status.dispose();
});

test("producer restart needs a new advancing baseline and failure never asserts video health", async () => {
  let clock = 1000, body = media(50, 3), fail = false;
  const status = createRemoteBroadcastFreshness({ now: () => clock, fetcher: async () => fail ? new Response("", { status: 503 }) : new Response(body) });
  assert.equal(await status.check(), false); body = media(50, 4); clock += 1000; assert.equal(await status.check(), true);
  body = media(0, 0, "new_init"); clock += 1000; assert.equal(await status.check(), false);
  body = media(0, 1, "new_init"); clock += 1000; assert.equal(await status.check(), true);
  fail = true; assert.equal(await status.check(), false); assert.equal(status.live, false);
  status.dispose();
});

test("public video probes reject arbitrary child URLs, redirects, overflow and ended media without a token", async () => {
  for (const child of ["https://evil.invalid/a.m3u8", "../a.m3u8", "sub/a.m3u8", "a.m3u8?token=x", "a%2Em3u8", "index.m3u8"]) {
    const calls = [];
    const status = createRemoteBroadcastFreshness({ token: "must-never-be-forwarded", fetcher: async (url, options) => { calls.push({ url, options }); return new Response(master.replace("video.m3u8", child)); } });
    assert.equal(await status.check(), false); assert.equal(calls.length, 1); assert.equal(JSON.stringify(calls).includes("must-never"), false); status.dispose();
  }
  for (const response of [new Response("x".repeat(32769)), new Response(media(1, 1) + "#EXT-X-ENDLIST\n"), new Response(media(1, 1).replace("DURATION=0.3", "DURATION=0"))]) {
    const status = createRemoteBroadcastFreshness({ fetcher: async () => response }); assert.equal(await status.check(), false); status.dispose();
  }
  const redirected = new Response(master); Object.defineProperty(redirected, "redirected", { value: true });
  const status = createRemoteBroadcastFreshness({ fetcher: async () => redirected }); assert.equal(await status.check(), false); status.dispose();
});

test("a hung video probe is bounded, cancellable and independent of payment/gratitude work", async () => {
  let signal;
  const status = createRemoteBroadcastFreshness({ deadlineMs: 20, fetcher: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = status.check(); assert.equal(status.live, false); status.dispose();
  assert.equal(await pending, false); assert.equal(signal.aborted, true); assert.equal(status.live, false);
  const deadline = createRemoteBroadcastFreshness({ deadlineMs: 20, fetcher: async () => new Promise(() => {}) });
  assert.equal(await deadline.check(), false); deadline.dispose();
  let cancelled = false;
  const body = createRemoteBroadcastFreshness({ deadlineMs: 20, fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  assert.equal(await body.check(), false); assert.equal(cancelled, true); body.dispose();
});
