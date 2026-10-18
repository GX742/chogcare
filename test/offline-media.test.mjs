import test from "node:test";
import assert from "node:assert/strict";
import { readScenePhotoResponse } from "../scripts/build-station-scenes.mjs";

test("offline photo download bounds chunked bodies and cancels an oversized source", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65)); }, cancel() { cancelled = true; } });
  await assert.rejects(readScenePhotoResponse(new Response(body), 64), /too large/);
  assert.equal(cancelled, true);
});

test("offline photo download rejects misleading Content-Length, HTTP errors and empty data", async () => {
  await assert.rejects(readScenePhotoResponse(new Response(new Uint8Array(65), { headers: { "Content-Length": "1" } }), 64), /too large/);
  await assert.rejects(readScenePhotoResponse(new Response("", { status: 503 }), 64), /unavailable/);
  await assert.rejects(readScenePhotoResponse(new Response(""), 64), /empty/);
});

test("offline photo download accepts an exact byte bound", async () => {
  assert.equal((await readScenePhotoResponse(new Response(new Uint8Array(64)), 64)).length, 64);
});
