import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Animate layout, not form scale; payment components keep their own lifecycle. */
export default function CheckoutSizeTransition({ children }: { children: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const outer = shell.current!, inner = content.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lastHeight = inner.getBoundingClientRect().height;
    let animation: Animation | undefined;
    const stop = () => { animation?.cancel(); animation = undefined; };
    const observer = new ResizeObserver(() => {
      const next = inner.getBoundingClientRect().height;
      if (Math.abs(next - lastHeight) < 1) return;
      // During a reversal, continue from the currently painted height.
      const from = animation?.playState === "running" ? outer.getBoundingClientRect().height : lastHeight;
      stop();
      lastHeight = next;
      if (reduced.matches || !from || !next) return;
      animation = outer.animate([{ height: `${from}px` }, { height: `${next}px` }], {
        duration: 420, easing: "cubic-bezier(.22, 1, .36, 1)",
      });
    });
    observer.observe(inner);
    reduced.addEventListener("change", stop);
    return () => { observer.disconnect(); reduced.removeEventListener("change", stop); stop(); };
  }, []);
  return <div className="checkout-size-transition" ref={shell}><div className="checkout-size-content" ref={content}>{children}</div></div>;
}
