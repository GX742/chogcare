import { useEffect, useState } from "react";

// Keep the displayed frame while the next one downloads. A slow or failed
// refresh must never replace a visible camera image with an empty rectangle.
export default function BroadcastPreview({ src, refresh, onReady, onAspect }: {
  src: string;
  refresh: boolean;
  onReady: () => void;
  onAspect: (width: number, height: number) => void;
}) {
  const [frames, setFrames] = useState<[string, string | null]>([src, null]);
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    if (!refresh || settled === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => {
        const next = new URL(src);
        next.searchParams.set("frame", String(Date.now()));
        setFrames(previous => active === 0 ? [previous[0], next.href] : [next.href, previous[1]]);
      }, ready ? 2500 : 4000);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [src, active, ready, settled, refresh]);

  return frames.map((url, index) => url && <img
    key={index}
    className={`care-broadcast-preview${index === active ? "" : " is-pending"}`}
    src={url}
    alt={index === active ? "Latest broadcast preview" : ""}
    aria-hidden={index !== active}
    decoding="async"
    fetchPriority={ready ? "low" : "high"}
    onLoad={event => {
      setActive(index); setReady(true); setSettled(value => value + 1);
      onAspect(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
      onReady();
    }}
    onError={() => setSettled(value => value + 1)}
  />);
}
