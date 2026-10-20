type Timer = ReturnType<typeof setTimeout>;

// A short buffering event or live-edge seek is normal during HLS playback.
// Keep the established LIVE indicator steady briefly, but never let repeated
// waiting events postpone a genuine interruption indefinitely.
export function createLivePlaybackStatus({ onChange, schedule = setTimeout, cancel = clearTimeout }: {
  onChange: (live: boolean) => void;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let live = false, disposed = false, timer: Timer | null = null;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const change = (value: boolean) => {
    if (disposed || live === value) return;
    live = value; onChange(value);
  };
  return {
    playing() { if (!disposed) { clear(); change(true); } },
    waiting() {
      if (disposed || !live || timer !== null) return;
      timer = schedule(() => { timer = null; change(false); }, 2500);
    },
    unavailable() { if (!disposed) { clear(); change(false); } },
    // Offscreen/hidden playback is not observable. Preserve its last status,
    // then let the resumed media report playing or begin a fresh bounded wait.
    suspend() { if (!disposed) clear(); },
    dispose() { disposed = true; clear(); },
    get live() { return live; },
  };
}
