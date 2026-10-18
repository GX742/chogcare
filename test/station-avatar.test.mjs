import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fetchStationAvatar, STATION_AVATAR_SIZE } from "../scripts/station-avatar.mjs";

const url = `https://gateway.pinata.cloud/ipfs/${"a".repeat(46)}/1462.webp`;
const fetchImage = bytes => async () => new Response(bytes);
const image = (width, height, background, channels = 3) => sharp({ create: { width, height, channels, background } });
const pixel = (bytes, x, y) => bytes.readUInt16BE((y * STATION_AVATAR_SIZE + x) * 2);

test("station avatar never requests a non-allowlisted or ambiguous URL", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("must not fetch"); };
  for (const candidate of [null, undefined, {}, "http://127.0.0.1/a.png", "file:///private.png", "https://evil.example/a.png", url.replace("gateway.pinata.cloud", "gateway.pinata.cloud.evil.example"), url.replace("https://", "https://user:pass@"), `${url}?token=private`, `${url}\n`, url.replace("/1462.webp", "/../private.png"), url.replace("/1462.webp", "/%2e%2e/private.png")]) {
    assert.equal(await fetchStationAvatar(candidate, { fetcher }), null);
  }
  assert.equal(calls, 0);
});

test("PNG resize contains the full image on the TFT background and emits RGB565 BE", async () => {
  const png = await image(128, 64, "#ff0000").png().toBuffer();
  let options;
  const result = await fetchStationAvatar(url, { fetcher: async (address, init) => {
    assert.equal(address, url); options = init; return new Response(png, { headers: { "content-type": "image/png" } });
  } });
  assert.equal(STATION_AVATAR_SIZE, 64);
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.length, 8192);
  assert.equal(pixel(result, 0, 0), 0x0823);
  assert.equal(pixel(result, 32, 15), 0x0823);
  assert.equal(pixel(result, 0, 16), 0xf800);
  assert.equal(pixel(result, 63, 47), 0xf800);
  assert.equal(pixel(result, 32, 48), 0x0823);
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Accept, "image/png, image/jpeg, image/webp");
});

test("JPEG and WebP raster inputs decode while transparency uses the exact TFT color", async () => {
  const jpeg = await image(8, 8, "#00ff00").jpeg({ quality: 100 }).toBuffer();
  const webp = await image(8, 8, "#0000ff").webp({ lossless: true }).toBuffer();
  const transparent = await image(8, 8, { r: 255, g: 0, b: 0, alpha: 0 }, 4).png().toBuffer();
  for (const [bytes, expected] of [[jpeg, 0x07e0], [webp, 0x001f], [transparent, 0x0823]]) {
    const result = await fetchStationAvatar(url, { fetcher: fetchImage(bytes) });
    assert.equal(result?.length, 8192);
    assert.equal(pixel(result, 32, 32), expected);
  }
});

test("animated WebP uses only its first frame", async () => {
  const first = await image(8, 8, "red").png().toBuffer();
  const second = await image(8, 8, "blue").png().toBuffer();
  const animated = await sharp([first, second], { join: { animated: true } }).webp({ lossless: true, delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const result = await fetchStationAvatar(url, { fetcher: fetchImage(animated) });
  assert.equal(result?.length, 8192);
  assert.equal(pixel(result, 32, 32), 0xf800);
});

test("non-raster, truncated and oversized decoded images select the built-in fallback", async () => {
  const tooManyPixels = await image(2001, 2000, "white").png().toBuffer();
  const png = await image(8, 8, "white").png().toBuffer();
  const gif = await image(8, 8, "white").gif().toBuffer();
  const avif = await image(8, 8, "white").avif().toBuffer();
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64"/></svg>'), Buffer.from("<html>error</html>"), gif, avif, png.subarray(0, 25), tooManyPixels]) {
    assert.equal(await fetchStationAvatar(url, { fetcher: fetchImage(bytes) }), null);
  }
});

test("network, HTTP and redirect failures select the fallback without following targets", async () => {
  const png = await image(1, 1, "red").png().toBuffer();
  for (const fetcher of [async () => { throw new Error("offline"); }, async () => new Response("error", { status: 503 }), async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }), async () => ({ ok: true, redirected: true, body: new Response(png).body }), async () => ({ ok: true, url: "https://evil.example/image.png", body: new Response(png).body })]) {
    assert.equal(await fetchStationAvatar(url, { fetcher }), null);
  }
});

test("image response cap rejects oversized headers and overflowing chunked bodies", async () => {
  for (const length of [String(2 * 1024 * 1024 + 1), "9".repeat(100), "invalid", "-1"]) {
    let reads = 0, canceled = false;
    const response = new Response(new ReadableStream({ pull() { reads++; }, cancel() { canceled = true; } }), { headers: { "content-length": length } });
    assert.equal(await fetchStationAvatar(url, { fetcher: async () => response }), null);
    // A ReadableStream may prefetch one chunk; no response reader is opened.
    assert.ok(reads <= 1);
    assert.equal(canceled, true);
  }
  let canceled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(700_000)); }, cancel() { canceled = true; } });
  assert.equal(await fetchStationAvatar(url, { fetcher: async () => new Response(body) }), null);
  assert.equal(canceled, true);
});

test("ten-second background deadline also bounds slow response bodies and aborts their reader", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false, canceled = false;
  const pending = fetchStationAvatar(url, { fetcher: async (_address, options) => {
    options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } }));
  } });
  await new Promise(setImmediate);
  t.mock.timers.tick(9999);
  assert.equal(aborted, false, "a cold IPFS request may finish after three seconds");
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.equal(canceled, true);
});
