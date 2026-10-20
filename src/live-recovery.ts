import { createLiveRetryBudget, type createLiveLoadState } from "./live-player.ts";

type Timer = ReturnType<typeof setTimeout>;
type Media = {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  play: () => Promise<void>;
};

// A paused/offscreen video is not evidence of a browser autoplay rejection.
// Recover the media itself, with a bounded fast budget and a slow cooldown,
// instead of turning a temporary suspension into a permanent Retry screen.
export function createLivePlaybackRecovery({
  media, active, monitor, resumeLoading, reconnect, onPlaying, onWaiting,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
}: {
  media: Media;
  active: () => boolean;
  monitor: ReturnType<typeof createLiveLoadState>;
  resumeLoading: () => void;
  reconnect: () => void;
  onPlaying: () => void;
  onWaiting: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  const budget = createLiveRetryBudget(now);
  let disposed = false, blocked = false, playPending = false, playEpoch = 0;
  let healthTimer: Timer | null = null, recoveryTimer: Timer | null = null;
  let lastTime = media.currentTime, lastProgress = now(), lastNudge = -Infinity;
  let recoveryOperation = reconnect, repairRequired = false;
  const invalidatePlay = () => { playEpoch++; playPending = false; };
  const clearHealth = () => { if (healthTimer !== null) cancel(healthTimer); healthTimer = null; };
  const clearRecovery = () => { if (recoveryTimer !== null) cancel(recoveryTimer); recoveryTimer = null; };
  const suspend = () => {
    invalidatePlay(); clearHealth(); clearRecovery(); monitor.suspend(); onWaiting();
  };
  const waiting = () => {
    if (disposed) return;
    if (!active()) { suspend(); return; }
    monitor.waiting(); onWaiting(); armHealth();
  };
  const markProgress = () => {
    const time = media.currentTime;
    if (!media.paused && !media.ended && Number.isFinite(time) && time < lastTime - .5) {
      // A restarted producer can establish a new timestamp origin without a
      // new playing event. Rebase once; only subsequent advancement is proof
      // that frames are moving again, not the backwards discontinuity itself.
      lastTime = time; lastProgress = now();
      return false;
    }
    if (!media.paused && !media.ended && Number.isFinite(time) && time > lastTime + .02) {
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
      if (!media.paused && media.readyState >= 3) {
        // play() on an already unpaused, stalled element can resolve without
        // any new frame. It must not erase a real buffering/connection state.
        const progressed = markProgress();
        if (wasPaused && !progressed) { monitor.playing(); onPlaying(); }
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
    if (!markProgress() && recoveryTimer === null) {
      const idle = now() - lastProgress;
      if (media.ended || idle >= 12_000) recover();
      else if ((media.paused || idle >= 4_000) && now() - lastNudge >= 3_000) {
        lastNudge = now();
        waiting();
        try { resumeLoading(); play(); } catch { recover(); }
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
    playing() {
      if (disposed || !active()) return;
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
      invalidatePlay(); lastTime = media.currentTime; lastProgress = now();
      if (media.paused || media.readyState < 3) waiting();
      if (repairRequired) recover(recoveryOperation, true);
      else if (recoveryTimer === null) { try { resumeLoading(); } catch { recover(); } }
      play(); armHealth();
    },
    resetSource() {
      if (!disposed) {
        invalidatePlay(); clearRecovery(); repairRequired = false;
        lastTime = media.currentTime; lastProgress = now();
      }
    },
    unavailable() { if (!disposed) { clearHealth(); clearRecovery(); monitor.unavailable(); onWaiting(); } },
    dispose() { disposed = true; invalidatePlay(); clearHealth(); clearRecovery(); budget.dispose(); },
  };
}
