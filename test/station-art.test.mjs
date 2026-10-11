import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rgb565, visibleBounds, STATION_ART_BACKGROUND } from "../scripts/build-station-art.mjs";

test("station artwork uses the exact display background and RGB565 colors", () => {
  assert.equal(rgb565(...STATION_ART_BACKGROUND), 0x0823);
  assert.equal(rgb565(255, 255, 255), 0xffff);
  assert.equal(rgb565(255, 0, 0), 0xf800);
  assert.equal(rgb565(0, 255, 0), 0x07e0);
  assert.equal(rgb565(0, 0, 255), 0x001f);
});

test("artwork padding ignores invisible export specks but preserves the visible coin", () => {
  const pixels = new Uint8Array(20 * 20 * 4);
  pixels[3] = 1;
  pixels[(8 * 20 + 7) * 4 + 3] = 255;
  pixels[(11 * 20 + 12) * 4 + 3] = 16;
  assert.deepEqual(visibleBounds(pixels, 20, 20), { left: 4, top: 5, width: 12, height: 10 });
  assert.throws(() => visibleBounds(new Uint8Array(16), 2, 2), /empty/);
});

test("compiled artwork is tied to the supplied PNG and stored only in flash", async () => {
  const source = await readFile(new URL("../public/chog-donation-coin.png", import.meta.url));
  const header = await readFile(new URL("../firmware/chogcare_station/StationArt.h", import.meta.url), "utf8");
  assert.ok(header.includes(`Source SHA256: ${createHash("sha256").update(source).digest("hex")}`));
  for (const [name, size] of [["IdleCoin", 128], ["DonationCoin", 96]]) {
    assert.ok(header.includes(`constexpr uint16_t ${name}Size = ${size};`));
    const array = header.match(new RegExp(`const uint16_t ${name}\\[${size} \\* ${size}\\] PROGMEM = \\{([\\s\\S]*?)\\};`));
    assert.ok(array, `${name} must be a flash-resident const bitmap`);
    const pixels = [...array[1].matchAll(/0x([0-9a-f]{4})/g)].map(match => Number.parseInt(match[1], 16));
    assert.equal(pixels.length, size * size);
    for (const at of [0, size - 1, size * (size - 1), size * size - 1]) assert.equal(pixels[at], 0x0823);
    assert.ok(new Set(pixels).size > 300, "Preserve a full-color coin, not a monochrome icon");
  }
});

test("coin placements fit between the existing text slots on the 240x320 display", () => {
  for (const box of [{ x: 56, y: 84, size: 128, top: 56, bottom: 248 }, { x: 72, y: 112, size: 96, top: 112, bottom: 208 }]) {
    assert.ok(box.x >= 12 && box.x + box.size <= 228);
    assert.ok(box.y >= box.top && box.y + box.size <= box.bottom);
  }
});
