// Public playlist transport/freshness only. This never receives a station token
// or claims that a viewer has decoded frames or reached the live edge.
const ORIGIN = "https://45.38.60.159", ROOT = "/live/station/", MASTER = `${ORIGIN}${ROOT}index.m3u8`;
const DEADLINE_MS = 5000, MAX_BYTES = 32768, FRESH_MS = 15000;
const childPlaylist = value => typeof value === "string" && value.length <= 128 && value.match(/^[A-Za-z0-9_-]+\.m3u8$/)?.[0] === value;
const childMedia = value => typeof value === "string" && value.length <= 180 && value.match(/^[A-Za-z0-9_-]+\.(?:mp4|m4s|ts)$/)?.[0] === value;

function lines(text) {
  if (typeof text !== "string" || !text.startsWith("#EXTM3U\n") && !text.startsWith("#EXTM3U\r\n")) throw Error("Invalid public playlist.");
  return text.split(/\r?\n/).filter(Boolean);
}
function mediaSnapshot(text, source) {
  const rows = lines(text);
  if (rows.some(line => line === "#EXT-X-ENDLIST" || line === "#EXT-X-PLAYLIST-TYPE:VOD")) throw Error("Public stream is not live.");
  const sequences = rows.filter(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  const targets = rows.filter(line => line.startsWith("#EXT-X-TARGETDURATION:"));
  if (sequences.length !== 1 || targets.length !== 1 || !/^#EXT-X-MEDIA-SEQUENCE:\d+$/.test(sequences[0]) || !/^#EXT-X-TARGETDURATION:[1-9]\d?$/.test(targets[0])) throw Error("Invalid public media playlist.");
  const sequence = Number(sequences[0].split(":")[1]), target = Number(targets[0].split(":")[1]);
  if (!Number.isSafeInteger(sequence) || target > 30) throw Error("Invalid public media timing.");
  const segments = []; let awaitingSegment = false;
  for (const row of rows) {
    if (row.startsWith("#EXTINF:")) {
      const duration = Number(row.match(/^#EXTINF:([0-9.]+),/)?.[1]);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60 || awaitingSegment) throw Error("Invalid public segment duration.");
      awaitingSegment = true;
    } else if (!row.startsWith("#")) {
      if (!awaitingSegment || !childMedia(row)) throw Error("Invalid public media path.");
      segments.push(row); awaitingSegment = false;
    }
  }
  if (awaitingSegment) throw Error("Incomplete public media.");
  const parts = rows.filter(line => line.startsWith("#EXT-X-PART:"));
  const partNames = parts.map(line => { const value = line.match(/[:,]URI="([^"]+)"/)?.[1], duration = Number(line.match(/[:,]DURATION=([0-9.]+)(?:,|$)/)?.[1]); if (!childMedia(value) || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw Error("Invalid public part path."); return value; });
  const maps = rows.filter(line => line.startsWith("#EXT-X-MAP:"));
  const map = maps.length ? maps.at(-1).match(/URI="([^"]+)"/)?.[1] : "";
  if (maps.length > 1 || maps.length && !childMedia(map)) throw Error("Invalid public initialization path.");
  if (!segments.length && !partNames.length) throw Error("No completed public media.");
  return { sequence, epoch: `${source}:${map}`, fingerprint: `${sequence}:${segments.at(-1) ?? ""}:${partNames.at(-1) ?? ""}` };
}

export function createRemoteBroadcastFreshness({ fetcher = fetch, now = Date.now, deadlineMs = DEADLINE_MS } = {}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > DEADLINE_MS) throw Error("Invalid public video deadline.");
  let disposed = false, current = null, advancedAt = -Infinity, checkedAt = -Infinity, success = false, running = null, controller = null, activeReader = null;
  let finishDispose; const disposedSignal = new Promise(ok => { finishDispose = ok; });
  const live = () => !disposed && success && Number.isFinite(advancedAt) && now() >= advancedAt && now() - advancedAt < FRESH_MS;
  async function read(url, signal) {
    const response = await fetcher(url, { headers: { Accept: "application/vnd.apple.mpegurl" }, credentials: "omit", redirect: "error", cache: "no-store", signal });
    if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) throw Error("Public video unavailable.");
    const length = response.headers.get("content-length");
    if (length !== null && (length.length > 10 || !/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw Error("Public playlist too large.");
    const reader = response.body.getReader(), chunks = []; let size = 0; activeReader = reader;
    try {
      while (true) { const { done, value } = await reader.read(); if (signal.aborted || disposed) throw Error("Public video probe stopped."); if (done) break; size += value.byteLength; if (size > MAX_BYTES) throw Error("Public playlist too large."); chunks.push(Buffer.from(value)); }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); if (activeReader === reader) activeReader = null; }
  }
  return {
    async check() {
      if (disposed) return false;
      if (running) return running;
      controller = new AbortController(); const signal = controller.signal;
      let timer;
      const operation = async () => {
        const master = await read(MASTER, signal), rows = lines(master);
        if (rows.some(line => line.startsWith("#EXT-X-TARGETDURATION:"))) return mediaSnapshot(master, MASTER);
        const variants = rows.filter(line => !line.startsWith("#"));
        if (!rows.some(line => line.startsWith("#EXT-X-STREAM-INF:")) || !variants.length || variants.some(value => !childPlaylist(value) || value === "index.m3u8")) throw Error("Invalid public variant.");
        const url = `${ORIGIN}${ROOT}${variants[0]}`;
        return mediaSnapshot(await read(url, signal), url);
      };
      running = (async () => {
        try {
          const next = await Promise.race([operation(), disposedSignal.then(() => null), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Public video deadline expired.")), deadlineMs); })]);
          if (!next || disposed) return false;
          const at = now(); success = true;
          if (at < checkedAt || !current || next.epoch !== current.epoch || next.sequence < current.sequence) advancedAt = -Infinity;
          else if (next.fingerprint !== current.fingerprint) advancedAt = at;
          current = next; checkedAt = at; return live();
        } catch { success = false; return false; }
        finally { clearTimeout(timer); controller?.abort(); try { void activeReader?.cancel().catch(() => {}); } catch {} controller = null; }
      })().finally(() => { running = null; });
      return running;
    },
    get live() { return live(); },
    dispose() { if (disposed) return; disposed = true; success = false; controller?.abort(); finishDispose(); },
  };
}
