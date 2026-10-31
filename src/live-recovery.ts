import { createLiveRetryBudget, LIVE_FIRST_BYTE_DEADLINE_MS, type createLiveLoadState } from "./live-player.ts";

type Timer = ReturnType<typeof setTimeout>;
type Media = {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  play: () => Promise<void>;
};
const STARTUP_LOAD_DEADLINE_MS = 60_000;
const PLAYBACK_STALL_MS = 45_000;
const NETWORK_PROGRESS_GRACE_MS = 10_000;
const MAX_PROGRESS_DEFERRAL_MS = 120_000;

// A paused/offscreen video is not evidence of a browser autoplay rejection.
// Recover the media itself, with a bounded fast budget and a slow cooldown,
// instead of turning a temporary suspension into a permanent Retry screen.
export function createLivePlaybackRecovery({
  media, active, monitor, resumeLoading, reconnect, onPlaying, onWaiting,
  frameDriven = false, transferProgress = () => null,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
}: {
  media: Media;
  active: () => boolean;
  monitor: ReturnType<typeof createLiveLoadState>;
  resumeLoading: (catchUp?: boolean) => void;
  reconnect: () => void;
  onPlaying: () => void;
  onWaiting: () => void;
  frameDriven?: boolean;
  transferProgress?: () => { request: object; loaded: number } | null;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  const budget = createLiveRetryBudget(now);
  let disposed = false, blocked = false, playPending = false, playEpoch = 0;
  let healthTimer: Timer | null = null, recoveryTimer: Timer | null = null;
  let lastTime = media.currentTime, lastProgress = now(), lastNudge = -Infinity;
  let sourceStartedAt = lastProgress, hasPlayedFrame = false, suspended = false;
  let recoveryOperation = reconnect, repairRequired = false;
  let playlistStale = false, transferRequest: object | null = null, transferLoaded = 0;
  let transferStartedAt = 0;
  let lastNetworkProgress = -Infinity;
  const invalidatePlay = () => { playEpoch++; playPending = false; };
  const clearHealth = () => { if (healthTimer !== null) cancel(healthTimer); healthTimer = null; };
  const clearRecovery = () => { if (recoveryTimer !== null) cancel(recoveryTimer); recoveryTimer = null; };
  const suspend = () => {
    suspended = true;
    invalidatePlay(); clearHealth(); clearRecovery(); monitor.suspend(); onWaiting();
  };
  const waiting = () => {
    if (disposed) return;
    if (!active()) { suspend(); return; }
    monitor.waiting(); onWaiting(); armHealth();
  };
  const markProgress = (decodedTime?: number) => {
    // A seek changes currentTime before a frame at that position is ready.
    // Those timeupdate events are not evidence of recovered playback.
    if (media.paused || media.ended || media.seeking || media.readyState < 2 || (frameDriven && decodedTime === undefined)) return false;
    const time = decodedTime ?? media.currentTime;
    if (Number.isFinite(time) && time < lastTime - .5) {
      // A restarted producer can establish a new timestamp origin without a
      // new playing event. Rebase once; only subsequent advancement is proof
      // that frames are moving again, not the backwards discontinuity itself.
      lastTime = time; lastProgress = now();
      return false;
    }
    if (Number.isFinite(time) && time > lastTime + .02) {
      hasPlayedFrame = true;
      lastTime = time; lastProgress = now(); if (!repairRequired) clearRecovery();
      monitor.playing(); onPlaying(); return true;
    }
    return false;
  };
  function play(userGesture = false) {
    if (disposed || !active() || playPending || (blocked && !userGesture)) return;
    if (userGesture) blocked = false;
    const epoch = ++playEpoch, wasPaused = media.paused;
    playPending = true;
    let result: Promise<void>;
    try { result = media.play(); } catch (problem) { result = Promise.reject(problem); }
    void result.then(() => {
      if (disposed || epoch !== playEpoch) return;
      playPending = false;
      if (!active()) return;
      if (!media.paused && !media.ended && !media.seeking && media.readyState >= 3) {
        // play() on an already unpaused, stalled element can resolve without
        // any new frame. It must not erase a real buffering/connection state.
        const progressed = markProgress();
        if (!frameDriven && wasPaused && !progressed) { monitor.playing(); onPlaying(); }
      }
      armHealth();
    }).catch((problem: unknown) => {
      if (disposed || epoch !== playEpoch) return;
      playPending = false;
      if (!active()) return;
      const mediaProblem = problem as { name?: string } | null;
      if (mediaProblem?.name === "NotAllowedError") {
        blocked = true; clearHealth(); clearRecovery(); monitor.blocked(); onWaiting();
      } else {
        // load()/source replacement and Safari suspension can abort play().
        // The health watchdog retries; an aborted promise is not a dead stream.
        waiting();
      }
    });
  }
  function recover(operation = reconnect, required = false) {
    if (disposed) return;
    recoveryOperation = operation;
    repairRequired ||= required;
    if (!active()) { suspend(); return; }
    if (blocked || recoveryTimer !== null) return;
    waiting();
    const delay = budget.nextDelay();
    if (delay === null) monitor.unavailable();
    recoveryTimer = schedule(() => {
      recoveryTimer = null;
      if (disposed || !active() || blocked) return;
      if (delay === null) { recover(recoveryOperation); return; }
      invalidatePlay(); lastTime = media.currentTime; lastProgress = now(); repairRequired = false;
      try { recoveryOperation(); } catch { recover(recoveryOperation); }
      armHealth();
    }, delay ?? budget.retryAfter());
  }
  function tick() {
    healthTimer = null;
    if (disposed || blocked) return;
    if (!active()) { suspend(); return; }
    // Fragment.stats is the loader's live counter. Loading events, retries or
    // repeated HTTP-200 playlists alone must not postpone recovery forever.
    try {
      const transfer = transferProgress();
      if (transfer && Number.isFinite(transfer.loaded) && transfer.loaded >= 0) {
        if (transfer.request !== transferRequest || transfer.loaded < transferLoaded) {
          transferRequest = transfer.request; transferLoaded = 0; transferStartedAt = now();
        }
        if (transfer.loaded > transferLoaded) {
          transferLoaded = transfer.loaded; lastNetworkProgress = now();
        }
      } else { transferRequest = null; transferLoaded = 0; transferStartedAt = 0; }
    } catch { transferRequest = null; transferLoaded = 0; transferStartedAt = 0; }
    if (!markProgress() && recoveryTimer === null) {
      const idle = now() - lastProgress;
      // Initial manifest, playlist and fragment requests can each take longer
      // than a playback stall. Give this source a finite first-frame deadline;
      // waiting events and seeks must not keep extending it or abort its loader.
      const timedOut = hasPlayedFrame ? idle >= PLAYBACK_STALL_MS : now() - sourceStartedAt >= STARTUP_LOAD_DEADLINE_MS;
      const stalledPlaylist = playlistStale && idle >= 4_000;
      const progressWindow = now() - (hasPlayedFrame ? lastProgress : sourceStartedAt);
      // A known request may still be waiting for the relay to switch transports.
      // Grant that request the same finite first-byte budget as the HLS loader;
      // source/playlist events cannot refresh it, and request churn cannot move
      // the overall hard ceiling measured from the last decoded progress.
      const pendingFirstByte = transferRequest !== null && transferLoaded === 0 && now() - transferStartedAt < LIVE_FIRST_BYTE_DEADLINE_MS;
      const usefulTransfer = (pendingFirstByte || now() - lastNetworkProgress < NETWORK_PROGRESS_GRACE_MS) && progressWindow < MAX_PROGRESS_DEFERRAL_MS;
      if (media.ended || ((timedOut || stalledPlaylist) && !usefulTransfer)) recover();
      else if ((media.paused || idle >= 4_000) && now() - lastNudge >= 3_000) {
        lastNudge = now();
        waiting();
        try { resumeLoading(false); play(); } catch { recover(); }
      }
    }
    armHealth();
  }
  function armHealth(delay = 1000) {
    if (!disposed && !blocked && active() && healthTimer === null) healthTimer = schedule(tick, delay);
  }
  return {
    play,
    waiting,
    recover,
    playlistStalled() { if (!disposed) { playlistStale = true; armHealth(); } },
    playlistAdvanced() { if (!disposed) playlistStale = false; },
    receivedData(bytes: number) { if (!disposed && Number.isFinite(bytes) && bytes > 0) lastNetworkProgress = now(); },
    frame(time: number) { if (!disposed && active() && !blocked) { markProgress(time); armHealth(); } },
    playing() {
      if (disposed || !active() || media.paused || media.ended || media.seeking || media.readyState < 2) return;
      if (frameDriven) { blocked = false; armHealth(); return; }
      hasPlayedFrame = true;
      blocked = false; lastTime = media.currentTime; lastProgress = now();
      if (!repairRequired) clearRecovery(); monitor.playing(); onPlaying(); armHealth();
    },
    progress() { if (!disposed && active() && !blocked) { markProgress(); armHealth(); } },
    paused() {
      if (disposed) return;
      invalidatePlay();
      if (!active()) { suspend(); return; }
      waiting(); clearHealth(); armHealth(250);
    },
    suspend() { if (!disposed) suspend(); },
    resume() {
      if (disposed || !active() || blocked) return;
      if (suspended && !hasPlayedFrame) sourceStartedAt = now();
      if (suspended) { lastTime = media.currentTime; lastProgress = now(); }
      suspended = false;
      invalidatePlay();
      if (media.paused || media.readyState < 3) waiting();
      if (repairRequired) recover(recoveryOperation, true);
      else if (recoveryTimer === null) { try { resumeLoading(true); } catch { recover(); } }
      play(); armHealth();
    },
    resetSource() {
      if (!disposed) {
        invalidatePlay(); clearRecovery(); repairRequired = false;
        lastTime = media.currentTime; lastProgress = now();
        sourceStartedAt = lastProgress; hasPlayedFrame = false;
        playlistStale = false; transferRequest = null; transferLoaded = 0; transferStartedAt = 0; lastNetworkProgress = -Infinity;
      }
    },
    unavailable() { if (!disposed) { clearHealth(); clearRecovery(); monitor.unavailable(); onWaiting(); } },
    dispose() { disposed = true; invalidatePlay(); clearHealth(); clearRecovery(); budget.dispose(); },
  };
}
