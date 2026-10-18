import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createStationBoardTransport } from "../scripts/station-board-wire.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const firmware = join(root, "firmware", "chogcare_station");
const source = name => readFile(join(firmware, name), "utf8");
const identity = "000000000000000000000001";

test("firmware keeps one bounded thumbnail and a 7.5 KiB render strip", async () => {
  const [board, display, config, application] = await Promise.all([
    source("StationLeaderboard.h"), source("StationDisplay.h"), source("StationConfig.h"), source("StationApplication.h"),
  ]);
  assert.match(board, /SIZE\s*=\s*64\s*,\s*PIXELS\s*=\s*SIZE\s*\*\s*SIZE/);
  assert.match(board, /uint16_t\s+pixels\[PIXELS\]/);
  assert.match(board, /SHOW_MS\s*=\s*8000/);
  assert.equal((display.match(/StationLeaderboard\s+board\s*;/g) ?? []).length, 1);
  assert.match(config, /STRIP_HEIGHT\s*=\s*16\s*;/);
  assert.match(display, /band\(240,\s*StationConfig::STRIP_HEIGHT\)/);
  assert.match(config, /LINE_BYTES\s*=\s*384\s*;/);
  assert.match(application, /char\s+line\[StationConfig::LINE_BYTES\s*\+\s*1\]/);
  assert.match(application, /uint16_t\s+budget\s*=\s*512/);
  assert.doesNotMatch(board.replace(/\/\/[^\n]*/g, ""), /\b(?:new|malloc|calloc|realloc|EEPROM|analogWrite|digitalWrite|HTTPClient|WiFiClient)\s*[.(]/);
});

test("board dispatch remains outside LED, durable donation ACK and persistence paths", async () => {
  const [application, display] = await Promise.all([source("StationApplication.h"), source("StationDisplay.h")]);
  const boardStart = application.indexOf("if (next.type != StationProtocol::Type::Donation)");
  const donationStart = application.indexOf("if (!strcmp(lastDone, next.id))", boardStart);
  assert.ok(boardStart > 0 && donationStart > boardStart);
  const dispatch = application.slice(boardStart, donationStart);
  assert.ok(dispatch.indexOf("if (active) return;") < dispatch.indexOf("display.beginBoard(next)"));
  assert.match(dispatch, /boardAck\(next.id,\s*"ready"\)/);
  assert.match(dispatch, /boardAck\(next.id,\s*"chunk"\)/);
  assert.match(dispatch, /boardAck\(next.id,\s*"shown"\)/);
  assert.doesNotMatch(dispatch, /\b(?:analogWrite|digitalWrite|persistLastDone|ack)\s*\(|\bEEPROM\b|current\s*=/);
  assert.match(application, /else\s+analogWrite\(StationConfig::LED_PIN,\s*0\)/);
  const show = display.slice(display.indexOf("void show("), display.indexOf("void idle("));
  assert.ok(show.indexOf("board.clear();") >= 0 && show.indexOf("board.clear();") < show.indexOf("active = true"));
  assert.match(display, /!active\s*&&\s*board.expire\(now\)/);
  assert.match(display, /!connected\s*&&\s*board.visible\(frameAt\)/);
});

async function transcript() {
  const lines = [], image = Buffer.alloc(8192);
  for (let pixel = 0; pixel < 4096; pixel++) image.writeUInt16BE((pixel * 31 + 0x1234) & 0xffff, pixel * 2);
  let transport;
  transport = createStationBoardTransport({ write(line) {
    lines.push(line); const message = JSON.parse(line);
    const [status, offset] = message.type === "board" ? ["ready", 0] : message.type === "pixels" ? ["chunk", Number(message.offset) + 64] : ["shown", 4096];
    queueMicrotask(() => transport.receive({ v: 1, type: "boardack", id: message.id, status, offset: String(offset) }));
  } });
  transport.setSupported(true);
  try {
    assert.equal(await transport.show({ id: identity, nick: "Гость GX", amount: "3,000.25", rank: 20, image }), true);
    return lines;
  } finally { transport.close(); }
}

test("actual host transcript fits every fixed MCU field and completes exactly 4096 pixels", async () => {
  const lines = await transcript();
  assert.equal(lines.length, 66);
  const commands = lines.map(line => JSON.parse(line));
  assert.equal(commands[0].type, "board");
  assert.deepEqual(commands.at(-1), { v: 1, type: "boardshow", id: identity });
  let offset = 0;
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 384);
  for (const command of commands.slice(1, -1)) {
    assert.equal(command.offset, String(offset)); assert.equal(command.data.length, 256);
    assert.match(command.data, /^[0-9a-f]+$/); offset += command.data.length / 4;
  }
  assert.equal(offset, 4096);
  const bytes = Buffer.concat(commands.slice(1, -1).map(command => Buffer.from(command.data, "hex")));
  for (let pixel = 0; pixel < 4096; pixel++) assert.equal(bytes.readUInt16BE(pixel * 2), (pixel * 31 + 0x1234) & 0xffff);
  assert.ok(Buffer.byteLength(commands[0].nick) <= 96 && [...commands[0].nick].length <= 24);
  assert.ok(commands[0].amount.length <= 110);
});

function compiler() {
  const candidates = [...new Set([process.env.CXX, "g++", "clang++", "c++"].filter(Boolean))];
  for (const binary of candidates) {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (!result.error && result.status === 0) return binary;
  }
  return null;
}

function withoutHardwareIncludes(value, allowed) {
  return value.replace(/^#include\s+([<"].*[>"])\s*$/gm, (line, target) => {
    assert.ok(allowed.includes(target), `New dependency needs an explicit hardware substitute: ${target}`);
    return "";
  });
}

test("portable C++ fixture executes real parser, staging and application dispatch", { timeout: 90_000 }, async t => {
  const binary = compiler();
  if (!binary) {
    t.skip("No runnable host C++ compiler. Source/transport checks above ran; native fixture requires CXX, g++ or clang++ (no installation attempted).");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "chogcare-station-firmware-"));
  try {
    const [config, application, lines] = await Promise.all([source("StationConfig.h"), source("StationApplication.h"), transcript()]);
    await Promise.all([
      writeFile(join(directory, "station-config-under-test.h"), withoutHardwareIncludes(config, ["<Arduino.h>"])),
      writeFile(join(directory, "station-application-under-test.h"), withoutHardwareIncludes(application, ["<Arduino.h>", "<EEPROM.h>", "<ESP8266WiFi.h>", '"StationConfig.h"', '"StationDisplay.h"', '"StationProtocol.h"'])),
      writeFile(join(directory, "host-commands.jsonl"), lines.join("")),
    ]);
    const executable = join(directory, process.platform === "win32" ? "station-firmware-test.exe" : "station-firmware-test");
    const compiled = spawnSync(binary, ["-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", firmware, "-I", directory,
      resolve(root, "test/fixtures/station-leaderboard-firmware.cpp"), "-o", executable], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, `Native fixture compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
    const executed = spawnSync(executable, [join(directory, "host-commands.jsonl")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.ifError(executed.error);
    assert.equal(executed.status, 0, `Native fixture failed:\n${executed.stdout}\n${executed.stderr}`);
    assert.equal(executed.stdout.trim().split(/\r?\n/).length, 4);
    t.diagnostic(executed.stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
