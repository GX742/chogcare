import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SCENE_ART, SCENE_PHOTO_WIDTH, SCENE_PHOTO_HEIGHT } from "../scripts/build-station-scenes.mjs";

test("all five initiative images are source-bound RGB565 in flash, not heap",async()=>{
  const header=await readFile(new URL("../firmware/chogcare_station/StationScenes.h",import.meta.url),"utf8");
  for(const asset of SCENE_ART){
    const source=await readFile(new URL(`../public/${asset.file}`,import.meta.url));
    assert.ok(header.includes(`${asset.cause}; source ${asset.file}; SHA256 ${createHash("sha256").update(source).digest("hex")}`));
    const block=header.split(`const uint16_t ${asset.key}[Width * Height] PROGMEM = {`)[1]?.split("};")[0];
    assert.ok(block);assert.equal([...block.matchAll(/0x[0-9a-f]{4}/g)].length,SCENE_PHOTO_WIDTH*SCENE_PHOTO_HEIGHT);
  }
});

test("screen story has bounded phases, explicit tests and no new network surface",async()=>{
  const config=await readFile(new URL("../firmware/chogcare_station/StationConfig.h",import.meta.url),"utf8");
  const display=await readFile(new URL("../firmware/chogcare_station/StationDisplay.h",import.meta.url),"utf8");
  const app=await readFile(new URL("../firmware/chogcare_station/StationApplication.h",import.meta.url),"utf8");
  const protocol=await readFile(new URL("../firmware/chogcare_station/StationProtocol.h",import.meta.url),"utf8");
  for(const [key,ms] of [["PHOTO_MS",6000],["AMOUNT_MS",4500],["THANKS_MS",4500]]) assert.ok(config.includes(`${key} = ${ms}`));
  for(const copy of ["Thank you!","You made a difference.","TEST / NO PAYMENT","SIMULATED - NO FUNDS MOVED","Original donation amount"]) assert.ok(display.includes(copy));
  assert.match(display,/GFXcanvas16 band/);assert.doesNotMatch(display,/HTTPClient|WiFiClient|JPEGDecoder|new uint16_t/);
  assert.ok(app.includes("WiFi.mode(WIFI_OFF)"));
  assert.ok(protocol.includes('bit = 64; skip();'));assert.ok(protocol.includes('strncmp(cursor, "true", 4)'));
  assert.ok(app.includes("current.cause, current.test"));
});

test("initiative screen is immediately visible text only, without photo or fade",async()=>{
  const display=await readFile(new URL("../firmware/chogcare_station/StationDisplay.h",import.meta.url),"utf8");
  assert.doesNotMatch(display,/StationScenes|void photo\(|float fade\(|brightness|previousFade/);
  assert.ok(display.includes('initiativeTitle(title1, title2[0] ? 145 : 164'));
  assert.ok(display.includes('initiativeTitle(title2, 187'));
  assert.ok(display.includes('gfxCenter("Your care goes to", &FreeSansBold9pt7b, 86'));
  assert.ok(display.includes('w <= 216 ? &FreeSansBold18pt7b : &FreeSansBold12pt7b'));
});

test("waiting and gratitude artwork preserves the requested image with rounded corners in flash",async()=>{
  const source=await readFile(new URL("../firmware/assets/chogcare-kindness.png",import.meta.url));
  const header=await readFile(new URL("../firmware/chogcare_station/StationBrand.h",import.meta.url),"utf8");
  assert.ok(header.includes(`Source SHA256: ${createHash("sha256").update(source).digest("hex")}`));
  for(const [name,size] of [["WaitingArt",176],["ThanksArt",128]]){
    const block=header.split(`const uint16_t ${name}[${size} * ${size}] PROGMEM = {`)[1]?.split("};")[0];
    assert.ok(block);const words=[...block.matchAll(/0x([0-9a-f]{4})/g)].map(m=>parseInt(m[1],16));
    assert.equal(words.length,size*size);
    for(const at of [0,size-1,size*(size-1),size*size-1])assert.equal(words[at],0x0823);
    assert.notEqual(words[Math.floor(size/2)],0x0823,"rounding must retain the image along each straight edge");
    assert.ok(new Set(words).size>1000);
  }
});
