// Local publisher intent only. Viewer HTTP or OBS's sent-byte counter alone
// cannot establish that a publisher reached the origin.
export const POLICY = Object.freeze({ healthyMs: 20_000, missingMs: 60_000, minimumSamples: 4,
  maxGapMs: 15_000, startupMs: 120_000, cooldownMs: 300_000, hourMs: 3_600_000,
  hourLimit: 2, stopDeadlineMs: 15_000, pollMs: 500, maximumPolls: 20 });
const need = value => { if (!value) throw Error("publisher_recovery_refused"); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.exec(value)?.[0] === value;
const time = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const shape = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const STATE_KEYS = ["version", "bootId", "sessionHash", "bindingHash", "last", "healthySince", "healthyAnchor", "failureSince", "failureSamples", "intents"];
const LAST_KEYS = ["atMs", "bytes", "duration", "frames", "publicId", "originId", "publicAdvancedAt", "originAdvancedAt", "producing", "bothMissing"];

export function createState(bootId, nowMs) {
  need(hash(bootId) && time(nowMs));
  return { version: 1, bootId, sessionHash: null, bindingHash: null, last: null,
    healthySince: null, healthyAnchor: null, failureSince: null, failureSamples: 0, intents: [] };
}
function reset(state, nowMs) { return { ...createState(state.bootId, nowMs), intents: [...state.intents] }; }
export function validateState(value, bootId, nowMs) {
  need(hash(bootId) && time(nowMs) && shape(value, STATE_KEYS) && value.version === 1 && hash(value.bootId) && JSON.stringify(value).length <= 8192);
  need(Array.isArray(value.intents) && value.intents.length <= POLICY.hourLimit && value.intents.every(time));
  need([value.healthySince, value.healthyAnchor, value.failureSince].every(at => at === null || time(at)) && count(value.failureSamples));
  if (value.last === null) need(value.sessionHash === null && value.bindingHash === null && value.healthySince === null && value.healthyAnchor === null && value.failureSince === null && value.failureSamples === 0);
  else {
    const last = value.last;
    need(hash(value.sessionHash) && hash(value.bindingHash) && shape(last, LAST_KEYS) && time(last.atMs) && [last.bytes, last.duration, last.frames].every(count));
    need([last.publicId, last.originId].every(id => id === null || hash(id)) && [last.publicAdvancedAt, last.originAdvancedAt].every(at => at === null || time(at) && at <= last.atMs));
    need(typeof last.producing === "boolean" && typeof last.bothMissing === "boolean" && [value.healthySince, value.healthyAnchor, value.failureSince].every(at => at === null || at <= last.atMs));
    need(value.failureSince === null ? value.failureSamples === 0 : value.failureSamples >= 1 && last.bothMissing);
  }
  const state = structuredClone(value);
  if (state.bootId !== bootId) return { ...createState(bootId, nowMs), intents: state.intents.map(() => nowMs) };
  need((state.last === null || state.last.atMs <= nowMs) && state.intents.every(at => at <= nowMs));
  return state;
}
const budget = (state, nowMs) => state.intents.length < POLICY.hourLimit && state.intents.every(at => nowMs - at >= POLICY.cooldownMs);
const validMedia = value => value?.status === 200 && value.valid === true && hash(value.mediaIdHash);

/** All observation fields are projections; never pass raw OBS service settings. */
export function evaluate(input, observation) {
  const { bootId, nowMs } = observation;
  let state = validateState(input, bootId, nowMs);
  state.intents = state.intents.filter(at => nowMs - at < POLICY.hourMs);
  const suspended = observation.enabled !== true || observation.connected !== true || observation.configChanging !== false || observation.unexpectedStop !== false ||
    observation.outputActive !== true || observation.outputReconnecting !== false || !hash(observation.sessionHash) || !hash(observation.bindingHash) ||
    ![observation.outputBytes, observation.outputDuration, observation.outputTotalFrames].every(count);
  if (suspended) return { state: reset(state, nowMs), action: null, status: "disarmed" };
  if (state.last && (state.sessionHash !== observation.sessionHash || state.bindingHash !== observation.bindingHash || nowMs - state.last.atMs > POLICY.maxGapMs ||
    observation.outputBytes < state.last.bytes || observation.outputDuration < state.last.duration || observation.outputTotalFrames < state.last.frames)) state = reset(state, nowMs);
  const previous = state.last;
  const producing = previous !== null && nowMs > previous.atMs && observation.outputBytes > previous.bytes && observation.outputDuration > previous.duration && observation.outputTotalFrames > previous.frames;
  const site = observation.publicHls, origin = observation.originHls;
  const media = [site, origin].every(validMedia);
  const advanced = (response, oldId, oldAt) => validMedia(response) && response.mediaIdHash !== oldId ? nowMs : oldAt;
  const publicAdvancedAt = advanced(site, previous?.publicId, previous?.publicAdvancedAt ?? null);
  const originAdvancedAt = advanced(origin, previous?.originId, previous?.originAdvancedAt ?? null);
  const bothMissing = site?.status === 404 && origin?.status === 404;
  state.sessionHash = observation.sessionHash; state.bindingHash = observation.bindingHash;
  state.last = { atMs: nowMs, bytes: observation.outputBytes, duration: observation.outputDuration, frames: observation.outputTotalFrames,
    publicId: validMedia(site) ? site.mediaIdHash : previous?.publicId ?? null, originId: validMedia(origin) ? origin.mediaIdHash : previous?.originId ?? null,
    publicAdvancedAt, originAdvancedAt, producing, bothMissing };
  const fresh = media && producing && previous !== null && publicAdvancedAt !== null && originAdvancedAt !== null &&
    nowMs - publicAdvancedAt <= POLICY.maxGapMs && nowMs - originAdvancedAt <= POLICY.maxGapMs;
  if (fresh) {
    state.healthySince ??= nowMs;
    if (nowMs - state.healthySince >= POLICY.healthyMs) state.healthyAnchor ??= nowMs;
  } else state.healthySince = null;
  if (bothMissing && producing && state.healthyAnchor !== null && observation.outputDuration >= POLICY.startupMs) {
    state.failureSince ??= nowMs; state.failureSamples++;
  } else { state.failureSince = null; state.failureSamples = 0; }
  const ready = state.failureSince !== null && nowMs - state.failureSince >= POLICY.missingMs && state.failureSamples >= POLICY.minimumSamples;
  const action = ready && budget(state, nowMs) ? { atMs: nowMs, sessionHash: state.sessionHash, bindingHash: state.bindingHash } : null;
  return { state, action, status: action ? "recovery_recommended" : ready ? "budget_hold" : bothMissing ? "missing_observed" : media ? "observing" : "http_hold" };
}

/** Persist the returned state before any StopStream; unknown outcomes consume it. */
export function reserveRecovery(input, action, nowMs) {
  const state = validateState(input, input.bootId, nowMs);
  state.intents = state.intents.filter(at => nowMs - at < POLICY.hourMs);
  need(action && action.atMs === nowMs && state.last?.atMs === nowMs && action.sessionHash === state.sessionHash && action.bindingHash === state.bindingHash &&
    state.last.bothMissing && state.last.producing && state.last.duration >= POLICY.startupMs && state.healthyAnchor !== null &&
    state.failureSince !== null && nowMs - state.failureSince >= POLICY.missingMs && state.failureSamples >= POLICY.minimumSamples && budget(state, nowMs));
  state.intents.push(nowMs); state.failureSince = null; state.failureSamples = 0;
  return state;
}

/** Runtime supplies fixed RPCs, bounded fresh inspections and one durable store.
 * No automatic retry or crash-resume of a StopStream/StartStream transaction.
 */
export async function recoverPublisher(io, { state, action, nowMs }) {
  const reserved = reserveRecovery(state, action, nowMs);
  await io.persist(reserved); // A failure here MUST prevent even StopStream.
  const began = io.now(); let stopped = false, startRequested = false;
  const remaining = () => !io.cancelled() && time(io.now()) && io.now() >= began && io.now() - began < POLICY.stopDeadlineMs;
  const matches = (value, before) => value?.connected === true && value.enabled === true && value.configChanging === false && value.unexpectedStop === false &&
    value.sessionHash === action.sessionHash && value.bindingHash === action.bindingHash && hash(value.connectionHash) &&
    (!before || value.connectionHash === before.connectionHash && value.cancelEpoch === before.cancelEpoch) && count(value.cancelEpoch);
  try {
    const before = await io.inspect();
    if (!remaining() || !matches(before) || before.bothMissing !== true || before.outputActive !== true || before.outputReconnecting !== false) return { state: reserved, stopped, startRequested, status: "lease_changed" };
    if (await io.stop() !== true) return { state: reserved, stopped, startRequested, status: "stop_unconfirmed" };
    for (let attempt = 0; attempt < POLICY.maximumPolls && remaining(); attempt++) {
      const current = await io.inspect();
      if (!remaining() || !matches(current, before) || current.outputReconnecting !== false) break;
      if (current.outputActive === false) {
        stopped = true;
        const final = await io.inspect();
        if (!remaining() || !matches(final, before) || final.outputActive !== false || final.outputReconnecting !== false) break;
        startRequested = true;
        const acknowledged = await io.start();
        return { state: reserved, stopped, startRequested, status: acknowledged === true ? "start_acknowledged" : "start_unknown" };
      }
      await io.sleep(); // Production adapter uses a fixed 500 ms delay.
    }
    return { state: reserved, stopped, startRequested, status: "recovery_held" };
  } catch { return { state: reserved, stopped, startRequested, status: startRequested ? "start_unknown" : "recovery_unknown" }; }
}
