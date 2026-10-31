// IntersectionObserver records describe an earlier render. Scroll/resize and
// observer notifications only invalidate presence; the next frame reads the
// current geometry once, so stale/batched records cannot latch a player off.
export function createLiveViewportPresence({
  read, onChange, schedule = requestAnimationFrame, cancel = cancelAnimationFrame,
}: {
  read: () => boolean;
  onChange: (present: boolean) => void;
  schedule?: (callback: () => void) => number;
  cancel?: (frame: number) => void;
}) {
  let present = false, disposed = false, frame: number | null = null;
  const clear = () => { if (frame !== null) cancel(frame); frame = null; };
  const change = (next: boolean) => {
    if (next === present) return;
    present = next;
    onChange(next);
  };
  return {
    invalidate() {
      if (disposed || frame !== null) return;
      frame = schedule(() => {
        frame = null;
        if (!disposed) change(read());
      });
    },
    suspend() { if (!disposed) { clear(); change(false); } },
    dispose() { disposed = true; clear(); },
  };
}
