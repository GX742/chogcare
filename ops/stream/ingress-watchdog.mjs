import { createHash } from "node:crypto";

// This observer measures completed media time, never PDT/server wall time.
export const POLICY = Object.freeze({
  pollMs: 5_000, windowMs: 30_000, startupGraceMs: 60_000,
  healthyWindowMs: 20_000, initialGraceMs: 120_000, initialWindowMs: 60_000,
  deficitWindowMs: 60_000, deficitMs: 15_000, cooldownMs: 300_000,
  hourMs: 3_600_000, hourLimit: 2, maxGapMs: 10_000, maxStateBytes: 32_768,
});
const hash = value => createHash("sha256").update(value).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
const child = (value, extension) => typeof value === "string" && value.length <= 165 &&
  new RegExp(`^[A-Za-z0-9_-]{1,160}\\.${extension}$`).test(value);
const finiteTime = value => Number.isFinite(value) && value >= 0;
function need(value) { if (!value) throw new Error("invalid_watchdog_state"); }
function shape(value, keys) {
  need(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
function lines(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536 || /\0/.test(text)) throw new Error("invalid_playlist");
  const result = text.replace(/\r\n/g, "\n").split("\n").map(line => line.trim());
  if (result.length > 4_096 || result[0] !== "#EXTM3U") throw new Error("invalid_playlist");
  return result;
}

/** Return the single video child; never return a URL, query, or audio rendition. */
export function parseMasterPlaylist(text) {
  const entries = lines(text);
  let waiting = false;
  const variants = [];
  for (const line of entries.slice(1)) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) { if (waiting) throw new Error("invalid_playlist"); waiting = true; }
    else if (!line.startsWith("#")) {
      if (!waiting || !child(line, "m3u8")) throw new Error("invalid_playlist");
      variants.push(line); waiting = false;
    }
  }
  if (waiting || variants.length !== 1) throw new Error("invalid_playlist");
  return variants[0];
}

/** Strict, bounded LL-HLS parser. Only complete EXTINF rows count as progress. */
export function parseMediaPlaylist(text) {
  try {
    const entries = lines(text);
    let sequence = null, init = null, duration = null;
    const segments = [];
    for (const line of entries.slice(1)) {
      if (!line) continue;
      if (/^#EXT-X-(?:ENDLIST|GAP|DISCONTINUITY(?:-SEQUENCE)?|SKIP|KEY)(?::|$)/.test(line)) return { eligible: false, reason: "unsupported_timeline" };
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        if (sequence !== null || !/^#EXT-X-MEDIA-SEQUENCE:\d{1,15}$/.test(line)) throw new Error();
        sequence = Number(line.slice(22));
        if (!Number.isSafeInteger(sequence)) throw new Error();
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const match = /^#EXT-X-MAP:URI="([A-Za-z0-9_-]{1,160}\.mp4)"$/.exec(line);
        if (init !== null || !match) throw new Error();
        init = hash(match[1]);
      } else if (line.startsWith("#EXTINF:")) {
        if (duration !== null || !/^#EXTINF:(?:\d+(?:\.\d{1,9})?),[^\r\n]*$/.test(line)) throw new Error();
        duration = Number(line.slice(8).split(",")[0]) * 1_000;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 10_000) throw new Error();
      } else if (!line.startsWith("#")) {
        if (duration === null || sequence === null || !child(line, "mp4") || segments.length >= 32) throw new Error();
        const id = hash(line);
        if (segments.some(segment => segment.id === id)) throw new Error();
        segments.push({ sequence: sequence + segments.length, id, durationMs: duration });
        duration = null;
      } else if (line.startsWith("#EXT-X-PART:") || line.startsWith("#EXT-X-PRELOAD-HINT:")) {
        // Parts are intentionally not counted. Reject URLs/traversal even here.
        const uri = /(?:^|,)URI="([^"]+)"/.exec(line.slice(line.indexOf(":") + 1));
        if (!uri || !child(uri[1], "mp4")) throw new Error();
      } else if (!/^#(?:EXT-X-(?:VERSION|TARGETDURATION|SERVER-CONTROL|PART-INF|INDEPENDENT-SEGMENTS|PROGRAM-DATE-TIME)|EXTM3U)(?::|$)/.test(line)) {
        throw new Error();
      }
    }
    if (duration !== null || sequence === null || init === null || !segments.length) throw new Error();
    return { eligible: true, initId: init, segments };
  } catch { return { eligible: false, reason: "malformed_playlist" }; }
}

function checkPlaylist(value) {
  shape(value, ["eligible", "initId", "segments"]);
  need(value?.eligible === true && isHash(value.initId) && Array.isArray(value.segments) && value.segments.length > 0 && value.segments.length <= 32);
  for (let index = 0; index < value.segments.length; index++) {
    const segment = value.segments[index];
    shape(segment, ["sequence", "id", "durationMs"]);
    need(Number.isSafeInteger(segment.sequence) && segment.sequence >= 0 && isHash(segment.id) &&
      finiteTime(segment.durationMs) && segment.durationMs > 0 && segment.durationMs <= 10_000 &&
      (index === 0 || segment.sequence === value.segments[index - 1].sequence + 1));
  }
  need(new Set(value.segments.map(segment => segment.id)).size === value.segments.length);
}
export function createState(bootId, nowMs) {
  need(isHash(bootId) && finiteTime(nowMs));
  return { version: 1, bootId, generation: null, startedAtMs: nowMs, last: null,
    history: [], healthyAnchor: null, pending: null, intents: [] };
}
function reset(state, nowMs) {
  return { ...createState(state.bootId, nowMs), intents: state.intents };
}
/** State is private data but is still untrusted after an interrupted write. */
export function validateState(value, bootId, nowMs) {
  need(isHash(bootId) && finiteTime(nowMs) && Buffer.byteLength(JSON.stringify(value)) <= POLICY.maxStateBytes);
  shape(value, ["version", "bootId", "generation", "startedAtMs", "last", "history", "healthyAnchor", "pending", "intents"]);
  need(value?.version === 1 && isHash(value.bootId) && finiteTime(value.startedAtMs) &&
    (value.generation === null || isHash(value.generation)) && Array.isArray(value.history) && value.history.length <= 64 &&
    Array.isArray(value.intents) && value.intents.length <= 2);
  const state = structuredClone(value);
  for (const at of state.intents) need(finiteTime(at));
  for (let index = 0; index < state.history.length; index++) {
    const point = state.history[index];
    shape(point, ["atMs", "edgeMs"]);
    need(finiteTime(point.atMs) && finiteTime(point.edgeMs) && (!index ||
      (point.atMs > state.history[index - 1].atMs && point.edgeMs >= state.history[index - 1].edgeMs)));
  }
  if (state.last !== null) {
    shape(state.last, ["atMs", "edgeMs", "playlist"]);
    need(finiteTime(state.last.atMs) && finiteTime(state.last.edgeMs)); checkPlaylist(state.last.playlist);
    need(state.history.length > 0 && state.history.at(-1).atMs === state.last.atMs && state.history.at(-1).edgeMs === state.last.edgeMs && isHash(state.generation));
  } else need(state.history.length === 0 && state.generation === null);
  if (state.healthyAnchor !== null) {
    shape(state.healthyAnchor, ["atMs", "edgeMs"]);
    need(state.last && finiteTime(state.healthyAnchor.atMs) && finiteTime(state.healthyAnchor.edgeMs) &&
      state.healthyAnchor.atMs >= state.startedAtMs && state.healthyAnchor.atMs <= state.last.atMs && state.healthyAnchor.edgeMs <= state.last.edgeMs);
  }
  if (state.pending !== null) {
    shape(state.pending, ["reason", "sinceMs"]);
    need(state.last && ["slow_timeline", "cumulative_deficit", "initial_slow_timeline"].includes(state.pending.reason) &&
      finiteTime(state.pending.sinceMs) && state.pending.sinceMs >= state.startedAtMs && state.pending.sinceMs <= state.last.atMs);
  }
  if (state.bootId !== bootId) {
    // No cross-boot monotonic comparison: retain every ambiguous intent for a
    // full new hour rather than accidentally granting a fresh restart budget.
    return { ...createState(bootId, nowMs), intents: state.intents.map(() => nowMs) };
  }
  need(state.startedAtMs <= nowMs && (!state.last || state.last.atMs <= nowMs) && state.intents.every(at => at <= nowMs));
  return state;
}

function progress(previous, current) {
  if (previous.initId !== current.initId || current.segments[0].sequence < previous.segments[0].sequence) return null;
  const matches = previous.segments.map((segment, index) => ({ segment, index,
    next: current.segments.findIndex(candidate => candidate.sequence === segment.sequence) })).filter(entry => entry.next >= 0);
  if (!matches.length) return null;
  for (const { segment, next } of matches) {
    const candidate = current.segments[next];
    if (candidate.id !== segment.id || Math.abs(candidate.durationMs - segment.durationMs) > 0.001) return null;
  }
  const anchor = matches[0];
  const sum = list => list.reduce((total, item) => total + item.durationMs, 0);
  const delta = sum(current.segments.slice(anchor.next)) - sum(previous.segments.slice(anchor.index));
  return delta < -0.001 ? null : Math.max(0, delta);
}
function windowRate(history, nowMs, windowMs) {
  const first = history.findLast(point => point.atMs <= nowMs - windowMs);
  const last = history.at(-1);
  if (!first || nowMs - first.atMs > windowMs + POLICY.maxGapMs) return null;
  return { rate: (last.edgeMs - first.edgeMs) / (nowMs - first.atMs),
    deficit: nowMs - first.atMs - (last.edgeMs - first.edgeMs) };
}
function budgetAvailable(state, nowMs) {
  const recent = state.intents.filter(at => nowMs - at < POLICY.hourMs);
  return recent.length < POLICY.hourLimit && recent.every(at => nowMs - at >= POLICY.cooldownMs);
}

/** Pure clock-injected decision; callers must revalidate all runtime leases. */
export function evaluate(inputState, observation) {
  const { nowMs, bootId, valid, generation, playlist, safe } = observation;
  let state = validateState(inputState, bootId, nowMs);
  state.intents = state.intents.filter(at => nowMs - at < POLICY.hourMs);
  if (!valid || !safe || !isHash(generation) || !playlist?.eligible) return { state: reset(state, nowMs), action: null, status: "ineligible" };
  checkPlaylist(playlist);
  const identity = hash(`${generation}:${playlist.initId}`);
  let delta = state.last ? progress(state.last.playlist, playlist) : null;
  if (state.generation !== identity || !state.last || nowMs - state.last.atMs > POLICY.maxGapMs || delta === null) {
    state = reset(state, nowMs); state.generation = identity;
    state.last = { atMs: nowMs, edgeMs: 0, playlist: structuredClone(playlist) };
    state.history = [{ atMs: nowMs, edgeMs: 0 }];
    return { state, action: null, status: "warming" };
  }
  if (nowMs === state.last.atMs && delta > 0) return { state: reset(state, nowMs), action: null, status: "clock_hold" };
  const edgeMs = state.last.edgeMs + delta;
  state.last = { atMs: nowMs, edgeMs, playlist: structuredClone(playlist) };
  if (state.history.at(-1).atMs === nowMs) state.history[state.history.length - 1] = { atMs: nowMs, edgeMs };
  else state.history.push({ atMs: nowMs, edgeMs });
  state.history = state.history.filter(point => nowMs - point.atMs <= 80_000).slice(-64);
  const short = windowRate(state.history, nowMs, POLICY.pollMs);
  const healthy = windowRate(state.history, nowMs, POLICY.healthyWindowMs);
  if (!state.healthyAnchor && healthy?.rate >= 0.8 && short?.rate >= 0.8) state.healthyAnchor = { atMs: nowMs, edgeMs };
  let reason = null;
  const age = nowMs - state.startedAtMs;
  if (age >= POLICY.startupGraceMs && short && short.rate < 0.8) {
    const normal = windowRate(state.history, nowMs, POLICY.windowMs);
    const initial = windowRate(state.history, nowMs, POLICY.initialWindowMs);
    if (state.healthyAnchor && normal?.rate < 0.5 && normal.deficit >= 12_000) reason = "slow_timeline";
    if (state.healthyAnchor && nowMs - state.healthyAnchor.atMs >= POLICY.deficitWindowMs &&
        nowMs - state.healthyAnchor.atMs - (edgeMs - state.healthyAnchor.edgeMs) >= POLICY.deficitMs) reason = "cumulative_deficit";
    if (!state.healthyAnchor && age >= POLICY.initialGraceMs + POLICY.initialWindowMs &&
        initial?.rate < 0.8 && initial.deficit >= POLICY.deficitMs) reason = "initial_slow_timeline";
  }
  if (!reason) state.pending = null;
  else if (state.pending?.reason !== reason) state.pending = { reason, sinceMs: nowMs };
  // The cumulative branch already requires >=60s anchored evidence. Requiring
  // another consecutive 5s tick would miss a real 0.7x stream whose complete
  // one-second segments quantize successive intervals to 3s / 4s of media.
  const ready = reason && state.pending && (reason !== "slow_timeline" || nowMs - state.pending.sinceMs >= POLICY.pollMs);
  const action = ready && budgetAvailable(state, nowMs) ? { reason, generation: identity, atMs: nowMs } : null;
  return { state, action, status: action ? "restart_recommended" : reason ? "slow_observed" : "observing" };
}

/** Persist this result atomically BEFORE requesting restart; unknown consumes it. */
export function reserveRestart(inputState, action, nowMs) {
  const state = validateState(inputState, inputState.bootId, nowMs);
  need(action && action.generation === state.generation && action.reason === state.pending?.reason &&
    action.atMs === nowMs && (action.reason !== "slow_timeline" || nowMs - state.pending.sinceMs >= POLICY.pollMs) && budgetAvailable(state, nowMs));
  state.intents = [...state.intents.filter(at => nowMs - at < POLICY.hourMs), nowMs];
  state.pending = null;
  return state;
}
