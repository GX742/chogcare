import type { HlsConfig } from "hls.js";

export const DEFAULT_LIVE_SEGMENT_SECONDS = 3;
export const MOBILE_LIVE_SEGMENT_SECONDS = 3;
export const LIVE_SYNC_SEGMENT_COUNT = 3;
export const LIVE_MAX_LATENCY_SEGMENT_COUNT = 6;
export const LIVE_FIRST_BYTE_DEADLINE_MS = 50_000;
export type LiveTransport = "relay" | "server";

export function liveRecoveryTiming(transport: LiveTransport = "relay") {
  return transport === "server"
    ? { startupMs: 12_000, stallMs: 6_000, firstByteMs: 4_000, progressMs: 3_000, hardMs: 24_000 }
    : { startupMs: 60_000, stallMs: 45_000, firstByteMs: LIVE_FIRST_BYTE_DEADLINE_MS, progressMs: 10_000, hardMs: 120_000 };
}

// Three-second media amortizes the public relay's request overhead. Keep the
// client target at six seconds rather than accumulating an unbounded backlog.
export function livePlaybackTiming(segmentSeconds = DEFAULT_LIVE_SEGMENT_SECONDS) {
  const balancedSegments = segmentSeconds === MOBILE_LIVE_SEGMENT_SECONDS;
  return {
    liveSyncDurationCount: balancedSegments ? 2 : LIVE_SYNC_SEGMENT_COUNT,
    liveMaxLatencyDurationCount: balancedSegments ? 4 : LIVE_MAX_LATENCY_SEGMENT_COUNT,
  };
}

// The deployed rendition can change segment duration without a frontend build.
// Keep one extra segment ahead of the live target and another for recovery.
export function liveBufferTiming(segmentSeconds = DEFAULT_LIVE_SEGMENT_SECONDS, transport: LiveTransport = "relay") {
  if (transport === "server") {
    const segment = liveSegmentSeconds(segmentSeconds);
    return { liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 6,
      maxBufferLength: Math.max(3, segment * 4), maxMaxBufferLength: Math.max(5, segment * 6) };
  }
  const segment = liveSegmentSeconds(segmentSeconds), timing = livePlaybackTiming(segment);
  return {
    ...timing,
    maxBufferLength: (timing.liveSyncDurationCount + 1) * segment,
    maxMaxBufferLength: (timing.liveSyncDurationCount + 2) * segment,
  };
}

export function livePlaylistKey(details: {
  endSN: number; lastPartSn?: number; lastPartIndex?: number;
  fragments: readonly ({ cc: number; readonly url: string } | null)[];
}): string | null {
  let last = null;
  for (let index = details.fragments.length - 1; index >= 0; index--) {
    if (details.fragments[index]) { last = details.fragments[index]; break; }
  }
  if (!last || !Number.isSafeInteger(details.endSN)) return null;
  // A producer restart can lower sequence numbers or reuse them with new URLs.
  return JSON.stringify([details.endSN, last.cc, last.url, details.lastPartSn ?? null, details.lastPartIndex ?? null]);
}

// Let portrait camera footage fill its frame without cropping the terminal.
// Landscape/offline footage retains the existing contained fallback layout.
export function portraitFrameAspect(width: number, height: number): number | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const ratio = width / height;
  return ratio >= .4 && ratio <= 1 ? ratio : undefined;
}

export function livePlaybackStrategy(mseSupported: boolean, nativeSupported: boolean, managedMediaSource = false): "hls" | "native" | "unsupported" {
  // Safari's native HLS handles iPhone streaming without a ManagedMediaSource
  // attachment. Chromium can advertise native HLS too; retain hls.js there.
  if (nativeSupported && managedMediaSource) return "native";
  return mseSupported ? "hls" : nativeSupported ? "native" : "unsupported";
}

type LiveLoadPolicies = Pick<HlsConfig, "manifestLoadPolicy" | "playlistLoadPolicy" | "fragLoadPolicy">;

function relayLoadPolicy(policy: HlsConfig["manifestLoadPolicy"], minimumLoadMs: number) {
  const original = policy.default;
  // A primary connection/idle failure plus the backup can consume 43 seconds.
  // Keep CDN overhead inside a finite first-byte budget, and preserve the
  // library's retry policies rather than replacing them with local defaults.
  const firstByte = Math.max(LIVE_FIRST_BYTE_DEADLINE_MS, Number.isFinite(original.maxTimeToFirstByteMs) ? original.maxTimeToFirstByteMs : 0);
  return {
    ...policy,
    default: {
      ...original,
      maxTimeToFirstByteMs: firstByte,
      maxLoadTimeMs: Math.max(minimumLoadMs, firstByte, Number.isFinite(original.maxLoadTimeMs) ? original.maxLoadTimeMs : 0),
      timeoutRetry: original.timeoutRetry === null ? null : { ...original.timeoutRetry },
      errorRetry: original.errorRetry === null ? null : { ...original.errorRetry },
    },
  };
}

function serverLoadPolicy(policy: HlsConfig["manifestLoadPolicy"], maximumLoadMs: number) {
  const original = policy.default;
  return { ...policy, default: { ...original, maxTimeToFirstByteMs: 4_000, maxLoadTimeMs: maximumLoadMs,
    timeoutRetry: original.timeoutRetry === null ? null : { ...original.timeoutRetry },
    errorRetry: original.errorRetry === null ? null : { ...original.errorRetry } } };
}

// Segment counts adapt to the actual rendition, including six-second media.
// A smaller back buffer limits memory; it is not an end-to-end latency target.
export function liveHlsConfig(segmentSeconds = DEFAULT_LIVE_SEGMENT_SECONDS, defaults?: LiveLoadPolicies, transport: LiveTransport = "relay"): Partial<HlsConfig> {
  const server = transport === "server";
  return {
    enableWorker: true,
    lowLatencyMode: true,
    liveSyncMode: "buffered",
    ...liveBufferTiming(segmentSeconds, transport),
    maxLiveSyncPlaybackRate: server ? 1.08 : 1.03,
    liveSyncOnStallIncrease: 0,
    liveMaxUnchangedPlaylistRefresh: server ? 3 : 6,
    backBufferLength: server ? 2 : 4,
    ...(defaults ? {
      manifestLoadPolicy: server ? serverLoadPolicy(defaults.manifestLoadPolicy, 8_000) : relayLoadPolicy(defaults.manifestLoadPolicy, 60_000),
      playlistLoadPolicy: server ? serverLoadPolicy(defaults.playlistLoadPolicy, 8_000) : relayLoadPolicy(defaults.playlistLoadPolicy, 60_000),
      fragLoadPolicy: server ? serverLoadPolicy(defaults.fragLoadPolicy, 12_000) : relayLoadPolicy(defaults.fragLoadPolicy, 120_000),
    } : {}),
  };
}

export function recoverLiveNetwork(
  loader: { readonly levels: readonly unknown[]; loadSource: (source: string) => void; startLoad: () => void },
  source: string,
  errorDetails: string,
): void {
  // startLoad() cannot request the initial manifest: PlaylistLoader.startLoad
  // is empty, and the stream controller has no levels to start loading yet.
  if (!loader.levels.length || errorDetails === "manifestLoadError" || errorDetails === "manifestLoadTimeOut") loader.loadSource(source);
  else loader.startLoad();
}

type SeekableRanges = {
  readonly length: number;
  start: (index: number) => number;
  end: (index: number) => number;
};
type LiveMedia = { currentTime: number; readonly seekable: SeekableRanges };
type Timer = ReturnType<typeof setTimeout>;
export type LiveLoadState = "loading" | "playing" | "blocked" | "unavailable";

// Network retries may continue in the background, but the visitor must never
// be left looking at an unbounded spinner or unable to start blocked autoplay.
export function createLiveLoadState({ onChange, schedule = setTimeout, cancel = clearTimeout }: {
  onChange: (state: LiveLoadState) => void;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let state: LiveLoadState = "loading", timer: Timer | null = null, disposed = false;
  const clear = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const change = (next: LiveLoadState) => { if (!disposed && state !== next) { state = next; onChange(next); } };
  return {
    waiting() {
      if (disposed || state === "blocked" || state === "unavailable") return;
      change("loading");
      if (timer === null) timer = schedule(() => { timer = null; change("unavailable"); }, 15_000);
    },
    playing() { if (disposed) return; clear(); change("playing"); },
    blocked() { if (disposed) return; clear(); change("blocked"); },
    unavailable() { if (disposed) return; clear(); change("unavailable"); },
    suspend() { clear(); },
    dispose() { disposed = true; clear(); },
    get state() { return state; },
  };
}

export function latestLiveRange(seekable: SeekableRanges): { start: number; end: number } | null {
  try {
    const count = seekable?.length;
    if (!Number.isSafeInteger(count) || count < 1 || count > 64) return null;
    let last = null;
    for (let index = 0; index < count; index++) {
      const start = seekable.start(index), end = seekable.end(index);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        (last && start < last.end)) return null;
      last = { start, end };
    }
    return last;
  } catch {
    // Native HLS can temporarily change its TimeRanges during a playlist update.
    return null;
  }
}

export function liveSegmentSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 60
    ? value : DEFAULT_LIVE_SEGMENT_SECONDS;
}

export function safeLiveResumeTarget(
  currentTime: number,
  seekable: SeekableRanges,
  segmentSeconds = DEFAULT_LIVE_SEGMENT_SECONDS,
  liveSyncPosition: number | null = null,
): number | null {
  const range = latestLiveRange(seekable);
  if (!range || !Number.isFinite(currentTime) || currentTime < 0) return null;
  const segment = liveSegmentSeconds(segmentSeconds);
  const span = range.end - range.start;
  // Never jump to the very last frame. Use the library's safe position when it
  // is available; Safari's native player uses the rendition's segment window.
  const maximum = range.end - Math.min(segment, span);
  const suggested = typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition) &&
    liveSyncPosition >= range.start && liveSyncPosition < range.end
    ? liveSyncPosition : range.end - livePlaybackTiming(segment).liveSyncDurationCount * segment;
  const target = Math.max(range.start, Math.min(suggested, maximum));
  // Resume only moves forward, and small fluctuations must not cause hopping.
  if (target <= currentTime || (currentTime >= range.start && target - currentTime < Math.max(0.5, segment))) return null;
  return target;
}

export function createLiveResumeSync({
  media,
  segmentSeconds = () => DEFAULT_LIVE_SEGMENT_SECONDS,
  liveSyncPosition = () => null,
  bufferRanges = () => media.seekable,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  media: LiveMedia & { readonly readyState: number; readonly seeking: boolean };
  segmentSeconds?: () => number;
  liveSyncPosition?: () => number | null;
  bufferRanges?: () => SeekableRanges;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let pending = false, disposed = false, remaining = 0, timer: Timer | null = null;
  const clearTimer = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const attempt = () => {
    if (disposed || !pending) return;
    clearTimer();
    remaining--;
    try {
      const ranges = bufferRanges(), range = latestLiveRange(ranges), currentTime = media.currentTime;
      // MSE callers supply buffered media: seekable metadata can point past the
      // downloaded frames and seeking there cancels a healthy pending fragment.
      // Native HLS retains its seekable window; both paths wait for decoded data.
      if (media.readyState >= 2 && !media.seeking && range && Number.isFinite(currentTime) && currentTime >= 0 && range.end > currentTime) {
        const target = safeLiveResumeTarget(currentTime, ranges, segmentSeconds(), liveSyncPosition());
        if (target !== null) media.currentTime = target;
        pending = false;
        return;
      }
    } catch { /* A not-yet-seekable media element gets only bounded retries. */ }
    if (remaining <= 0) { pending = false; return; }
    timer = schedule(() => { timer = null; attempt(); }, 1000);
  };
  return {
    request() { if (disposed) return; pending = true; remaining = 3; attempt(); },
    update() { if (pending) attempt(); },
    dispose() { disposed = true; pending = false; clearTimer(); },
    get pending() { return pending; },
  };
}

// Fatal errors can otherwise repeatedly restart loading with no upper bound.
// Healthy long-running playback gets a fresh budget after the previous window.
export function createLiveRetryBudget(now = Date.now) {
  let attempts: number[] = [], disposed = false;
  return {
    nextDelay(): number | null {
      if (disposed) return null;
      const timestamp = now();
      attempts = attempts.filter(time => timestamp - time < 60_000);
      if (attempts.length >= 3) return null;
      const delay = 1000 * 2 ** attempts.length;
      attempts.push(timestamp);
      return delay;
    },
    retryAfter(): number {
      return attempts.length ? Math.max(1000, 60_000 - (now() - attempts[0])) : 1000;
    },
    dispose() { disposed = true; attempts = []; },
  };
}

// Safari has no hls.js latency controller. Catch up only after substantial
// drift, never on every playlist update or while the user/browser is paused.
export function createLiveDriftSync({
  media, active = () => true, segmentSeconds = () => DEFAULT_LIVE_SEGMENT_SECONDS,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
}: {
  media: LiveMedia & { readonly paused: boolean; readonly ended: boolean; readonly seeking: boolean; readonly readyState: number };
  active?: () => boolean;
  segmentSeconds?: () => number;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let running = false, disposed = false, timer: Timer | null = null, lastSeek = -Infinity;
  const tick = () => {
    timer = null;
    if (!running || disposed) return;
    try {
      if (active() && !media.paused && !media.ended && !media.seeking && media.readyState >= 2 && now() - lastSeek >= 10_000) {
        const range = latestLiveRange(media.seekable), segment = liveSegmentSeconds(segmentSeconds());
        const maximumSegments = livePlaybackTiming(segment).liveMaxLatencyDurationCount;
        if (range && range.end - media.currentTime > maximumSegments * segment) {
          const target = safeLiveResumeTarget(media.currentTime, media.seekable, segment);
          if (target !== null) { media.currentTime = target; lastSeek = now(); }
        }
      }
    } catch { /* Native ranges/seeking may change while a playlist refreshes. */ }
    if (running && !disposed) timer = schedule(tick, 1500);
  };
  return {
    start() { if (disposed || running) return; running = true; timer = schedule(tick, 1500); },
    dispose() { disposed = true; running = false; if (timer !== null) cancel(timer); timer = null; },
  };
}
