import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATION_ART_BACKGROUND = [15, 5, 25];
export function rgb565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

// Ignore nearly invisible export specks when finding the transparent padding.
// Keep a 3px source margin so the coin's antialiased edge is not cut off.
export function visibleBounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("Station artwork is empty.");
  left = Math.max(0, left - 3); top = Math.max(0, top - 3);
  right = Math.min(width - 1, right + 3); bottom = Math.min(height - 1, bottom + 3);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function bitmapDeclaration(name, width, values) {
  const rows = [];
  for (let at = 0; at < values.length; at += 16) {
    rows.push(`  ${values.slice(at, at + 16).map(value => `0x${value.toString(16).padStart(4, "0")}`).join(", ")},`);
  }
  return `constexpr uint16_t ${name}Size = ${width};\nconst uint16_t ${name}[${width} * ${width}] PROGMEM = {\n${rows.join("\n")}\n};`;
}

export async function buildStationArt(sharpDirectory, check = false) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // sharp is needed only for this offline asset build, never on the NodeMCU.
  const require = createRequire(sharpDirectory ? resolve(sharpDirectory, "package.json") : import.meta.url);
  const sharp = require("sharp");
  const input = await readFile(resolve(project, "public/chog-donation-coin.png"));
  const sha = createHash("sha256").update(input).digest("hex");
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = visibleBounds(data, info.width, info.height);
  const declarations = [];
  const previews = [];
  for (const [name, size] of [["IdleCoin", 128], ["DonationCoin", 96]]) {
    const { data: pixels, info: resized } = await sharp(input).extract(bounds)
      .resize(size, size, { fit: "contain", background: { r: 15, g: 5, b: 25, alpha: 1 }, kernel: "lanczos3" })
      .flatten({ background: { r: 15, g: 5, b: 25 } }).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    if (resized.width !== size || resized.height !== size || resized.channels !== 3) throw new Error("Unexpected station bitmap format.");
    const values = [];
    const preview = Buffer.alloc(size * size * 3);
    for (let at = 0; at < pixels.length; at += 3) {
      const value = rgb565(pixels[at], pixels[at + 1], pixels[at + 2]);
      values.push(value);
      preview[at] = Math.round(((value >> 11) & 31) * 255 / 31);
      preview[at + 1] = Math.round(((value >> 5) & 63) * 255 / 63);
      preview[at + 2] = Math.round((value & 31) * 255 / 31);
    }
    declarations.push(bitmapDeclaration(name, size, values));
    previews.push({ name, size, pixels: preview });
  }
  const output = `#pragma once\n#include <Arduino.h>\n#include <pgmspace.h>\n\n// Generated from public/chog-donation-coin.png. Do not hand-edit pixel data.\n// Source SHA256: ${sha}\n// Transparent padding: ${JSON.stringify(bounds)}\n// RGB565; transparent pixels match StationDisplay's background (0x0823).\n// 51,200 bytes in flash, no PNG decoder or additional runtime framebuffer.\nnamespace StationArt {\n${declarations.join("\n\n")}\n}\n`;
  const target = resolve(project, "firmware/chogcare_station/StationArt.h");
  if (check) {
    if (await readFile(target, "utf8") !== output) throw new Error("StationArt.h is stale; regenerate the artwork.");
  } else {
    await writeFile(target, output);
    const previewDirectory = resolve(project, "work/station-art");
    await mkdir(previewDirectory, { recursive: true });
    for (const preview of previews) {
      await sharp(preview.pixels, { raw: { width: preview.size, height: preview.size, channels: 3 } })
        .png().toFile(resolve(previewDirectory, `${preview.name}.png`));
    }
  }
  console.log(`${check ? "Verified" : "Built"} ST7789 coin artwork: 128px idle / 96px donation; 51,200 flash bytes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.includes("--check");
  const paths = arguments_.filter(value => value !== "--check");
  if (paths.length > 1) throw new Error("Usage: node scripts/build-station-art.mjs [sharp-package-directory] [--check]");
  await buildStationArt(paths[0], check);
}
