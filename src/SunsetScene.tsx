import { useRef, type RefObject } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import HeartField from "./HeartField";
import { landingPositioned } from "./landing-transition";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export default function SunsetScene({ checkout, heroRef, bridgeRef }: { checkout: boolean; heroRef: RefObject<HTMLElement | null>; bridgeRef: RefObject<HTMLDivElement | null> }) {
  const scope = useRef<HTMLDivElement>(null);
  const hearts = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const hero = heroRef.current;
    const bridge = bridgeRef.current;
    if (checkout || !hero || !bridge || !hearts.current) return;
    let sceneTween: gsap.core.Tween | undefined;
    const media = gsap.matchMedia();
    media.add({ motion: "(prefers-reduced-motion: no-preference)", reduced: "(prefers-reduced-motion: reduce)" }, context => {
      // Fade an opaque heart scene OVER the illustration. The illustration
      // never becomes translucent, so hearts cannot leak through at the top.
      sceneTween = gsap.fromTo(hearts.current, { opacity: 0 }, {
        opacity: 1, ease: "none",
        scrollTrigger: { trigger: hero, start: "bottom 85%", end: "bottom 25%", scrub: context.conditions?.reduced ? true : .25, invalidateOnRefresh: true },
      });
    });
    const alignWithViewport = () => {
      const trigger = sceneTween?.scrollTrigger;
      if (!trigger) return;
      trigger.refresh();
      trigger.update();
      const scrubTween = trigger.getTween();
      if (scrubTween && typeof scrubTween.progress === "function") scrubTween.progress(1);
      sceneTween?.progress(trigger.progress);
    };
    // An anchor return is not a scroll animation: settle the heart layer before
    // the destination snapshot, without briefly exposing the hero illustration.
    window.addEventListener(landingPositioned, alignWithViewport);
    const observer = new ResizeObserver(() => sceneTween?.scrollTrigger?.refresh());
    observer.observe(hero);
    observer.observe(bridge);
    return () => { window.removeEventListener(landingPositioned, alignWithViewport); observer.disconnect(); media.revert(); };
  }, { scope, dependencies: [checkout], revertOnUpdate: true });
  return <div className="care-world" ref={scope} data-checkout={checkout} aria-hidden="true">
    <div className="care-sunset-scene"><div className="care-sunset-art"/><div className="care-sunset-shade"/></div>
    <div className="care-heart-scene" ref={hearts}><HeartField paused={false}/></div>
  </div>;
}
