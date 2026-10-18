import type { HlsConfig } from "hls.js";

export const DEFAULT_LIVE_SEGMENT_SECONDS = 3;
export const LIVE_SYNC_SEGMENT_COUNT = 3;
export const LIVE_MAX_LATENCY_SEGMENT_COUNT = 12;

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

// Segment counts adapt when Owncast changes from 3-second to shorter segments.
// A smaller back buffer limits memory; it is not an end-to-end latency target.
export function liveHlsConfig(): Partial<HlsConfig> {
  return {
    enableWorker: true,
    lowLatencyMode: true,
    liveSyncDurationCount: LIVE_SYNC_SEGMENT_COUNT,
    liveMaxLatencyDurationCount: LIVE_MAX_LATENCY_SEGMENT_COUNT,
    maxLiveSyncPlaybackRate: 1,
    liveSyncOnStallIncrease: 1,
    maxBufferLength: 8,
    maxMaxBufferLength: 16,
    backBufferLength: 8,
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
  // is available; Safari's native player falls back to three complete segments.
  const maximum = range.end - Math.min(segment, span);
  const suggested = typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition) &&
    liveSyncPosition >= range.start && liveSyncPosition < range.end
    ? liveSyncPosition : range.end - LIVE_SYNC_SEGMENT_COUNT * segment;
  const target = Math.max(range.start, Math.min(suggested, maximum));
  // Resume only moves forward, and small fluctuations must not cause hopping.
  if (target <= currentTime || (currentTime >= range.start && target - currentTime < Math.max(0.5, segment))) return null;
  return target;
}

export function createLiveResumeSync({
  media,
  segmentSeconds = () => DEFAULT_LIVE_SEGMENT_SECONDS,
  liveSyncPosition = () => null,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  media: LiveMedia;
  segmentSeconds?: () => number;
  liveSyncPosition?: () => number | null;
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
      const ranges = media.seekable;
      if (latestLiveRange(ranges) && Number.isFinite(media.currentTime) && media.currentTime >= 0) {
        const target = safeLiveResumeTarget(media.currentTime, ranges, segmentSeconds(), liveSyncPosition());
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
    dispose() { disposed = true; attempts = []; },
  };
}
