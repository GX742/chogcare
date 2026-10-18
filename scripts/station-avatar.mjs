import sharp from "sharp";
import { safeLeaderboardAvatarImage } from "../src/leaderboard-model.ts";

export const STATION_AVATAR_SIZE = 64;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
// The IPFS gateway can take several seconds on a cold request. This is host
// background work; the donation/USB heartbeat loop never waits for it.
const DEADLINE_MS = 10_000;
const background = { r: 15, g: 5, b: 25 };

function rasterFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// The host alone fetches/decodes images. The ESP receives fixed RGB565 pixels,
// never a URL or an image decoder. Failure selects its built-in coin instead.
export async function fetchStationAvatar(url, { fetcher = fetch } = {}) {
  if (!safeLeaderboardAvatarImage(url)) return null;
  const controller = new AbortController();
  let reader = null, body = null, decoder = null, timer;
  const stop = () => {
    controller.abort();
    try { void (reader ?? body)?.cancel().catch(() => {}); } catch { /* Already released/closed. */ }
    decoder?.destroy();
  };
  const operation = async () => {
    try {
      const response = await fetcher(url, {
        headers: { Accept: "image/png, image/jpeg, image/webp" },
        redirect: "error", signal: controller.signal,
      });
      body = response.body;
      if (controller.signal.aborted || !response.ok || response.redirected ||
          (response.url && response.url !== url) || !response.body) return null;
      const length = response.headers.get("content-length");
      if (length !== null && (length.length > 16 || !/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))) return null;
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) return null;
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) return null;
          chunks.push(Buffer.from(value));
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        reader = null;
      }
      const input = Buffer.concat(chunks, size), format = rasterFormat(input);
      if (!format) return null;
      decoder = sharp(input, {
        failOn: "warning", limitInputPixels: MAX_PIXELS,
        unlimited: false, animated: false, page: 0, pages: 1,
      });
      const metadata = await decoder.metadata();
      if (metadata.format !== format || !Number.isSafeInteger(metadata.width) ||
          !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 ||
          metadata.width * metadata.height > MAX_PIXELS || controller.signal.aborted) return null;
      const { data, info } = await decoder.rotate()
        .resize(STATION_AVATAR_SIZE, STATION_AVATAR_SIZE, { fit: "contain", background })
        .flatten({ background }).toColourspace("srgb").removeAlpha().raw()
        .timeout({ seconds: 3 }).toBuffer({ resolveWithObject: true });
      if (controller.signal.aborted || info.width !== STATION_AVATAR_SIZE ||
          info.height !== STATION_AVATAR_SIZE || info.channels !== 3 ||
          data.length !== STATION_AVATAR_SIZE * STATION_AVATAR_SIZE * 3) return null;
      const pixels = Buffer.alloc(STATION_AVATAR_SIZE * STATION_AVATAR_SIZE * 2);
      for (let at = 0, out = 0; at < data.length; at += 3, out += 2) {
        pixels.writeUInt16BE(((data[at] & 0xf8) << 8) | ((data[at + 1] & 0xfc) << 3) | (data[at + 2] >> 3), out);
      }
      return pixels;
    } catch { return null; }
  };
  try {
    const deadline = new Promise(resolve => { timer = setTimeout(() => { stop(); resolve(null); }, DEADLINE_MS); });
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
    stop();
  }
}
