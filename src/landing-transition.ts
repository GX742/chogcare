import gsap from "gsap";

export const landingPositioned = "chogcare:landing-positioned";

// Transition the viewport, not individual card contents. The destination is
// complete before it is revealed; no empty purple panel or fake loading state.
export function transitionLanding(update: () => void) {
  let cancelled = false, settled = false;
  let native: ViewTransition | undefined;
  let context: gsap.Context | undefined;
  let veil: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve: () => void = () => {};
  const finished = new Promise<void>(done => { resolve = done; });
  const settle = () => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    context?.revert();
    veil?.remove();
    document.documentElement.classList.remove("care-navigation-transition");
    resolve();
  };
  const apply = () => { if (!cancelled) update(); };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    timer = setTimeout(() => { try { apply(); } finally { settle(); } }, 0);
  } else if (typeof document.startViewTransition === "function") {
    document.documentElement.classList.add("care-navigation-transition");
    native = document.startViewTransition(apply);
    void native.ready.catch(() => {});
    void native.finished.then(settle, settle);
  } else {
    // Older browsers: cover the route change with a brief, soft viewport veil.
    // The form is inert while navigating; no fields or invoices are cloned.
    veil = document.createElement("div");
    veil.className = "care-navigation-veil";
    veil.setAttribute("aria-hidden", "true");
    document.body.appendChild(veil);
    context = gsap.context(() => {
      gsap.timeline({ onComplete: settle })
        .to(veil!, { opacity: 1, duration: .14, ease: "power1.inOut" })
        .call(apply)
        .to(veil!, { opacity: 0, duration: .28, ease: "power2.out" });
    }, veil);
  }
  return { finished, cancel: () => { cancelled = true; native?.skipTransition(); settle(); } };
}
