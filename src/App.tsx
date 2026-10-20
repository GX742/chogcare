import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type HlsType from "hls.js";
import { ArrowRight, ArrowUpRight, Check, Copy, Broadcast, ChatCircle, X, XLogo } from "@phosphor-icons/react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import type PaymentCheckoutView from "./PaymentCheckout";
import ChangeInitiative from "./ChangeInitiative";
import SunsetScene from "./SunsetScene";
import GivingExplainer from "./GivingExplainer";
import { landingPositioned, transitionLanding } from "./landing-transition";
import { GIVETH_PROJECT_URL } from "./route";
import { checkoutChanged, checkoutSelection, rememberMode } from "./checkout-session";
import CheckoutRecovery from "./CheckoutRecovery";
import CheckoutSizeTransition from "./CheckoutSizeTransition";
import Leaderboard from "./Leaderboard";
import SupportDialog from "./SupportDialog";
import BroadcastPreview from "./BroadcastPreview";
import type { SupportContext } from "./support-model";
import { createLiveDriftSync, createLiveLoadState, createLiveResumeSync, liveHlsConfig, livePlaybackStrategy, liveSegmentSeconds, portraitFrameAspect, recoverLiveNetwork, DEFAULT_LIVE_SEGMENT_SECONDS, type LiveLoadState } from "./live-player";
import { createLivePlaybackRecovery } from "./live-recovery";
import { createLivePlaybackStatus } from "./live-status";
import { broadcastPreviewUrl, broadcastStreamUrl } from "./broadcast-source";

import "./station-redesign.css";
import "./sunset-redesign.css";
import "./payment-entry.css";
import "./payment-invoice.css";
import "./leaderboard-impact.css";

let paymentCheckoutView: typeof PaymentCheckoutView | null = null;
const loadPaymentCheckout = () => import("./PaymentCheckout").then(module => { paymentCheckoutView = module.default; return module.default; });

function PaymentCheckout(props: Parameters<typeof PaymentCheckoutView>[0]) {
  const [View, setView] = useState<typeof PaymentCheckoutView | null>(() => paymentCheckoutView);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (View) return;
    let active = true;
    setFailed(false);
    void loadPaymentCheckout().then(component => { if (active) setView(() => component); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [View]);
  return View ? <View {...props}/> : <div className="checkout-help" role="status">
    {failed ? <>Donation options couldn’t load. <button type="button" className="lp-text-button" onClick={() => window.location.reload()}>Reload page</button></> : "Loading donation options…"}
  </div>;
}

type Initiative = {
  id: string;
  name: string;
  category: string;
  location: string;
  image: string;
  imageAlt: string;
  summary: string;
  cardSummary?: string;
  details: string;
  raised: number | null;
  archived?: boolean;
  external?: boolean;
  externalLabel?: string;
  givethUrl: string;
  live: boolean;
  holderLive?: boolean;
};

const initiatives: Initiative[] = [
  {
    id: "burundi",
    archived: true,
    name: "Perfect Villages in Burundi",
    category: "Communities",
    location: "Burundi",
    image: "https://giveth.mypinata.cloud/ipfs/QmbgeaiXhof9iLzg8F8nQ5pP9QwYfsQKdHGq2ecGpqKrck",
    imageAlt: "Community members supported by Perfect Villages in Burundi",
    summary: "Agroecology and practical support for vulnerable rural communities.",
    details: "Perfect Village Communities works with rural families in Burundi to improve everyday living conditions through agroecology, permaculture and community-led development. The project combines food security with skills that can keep creating value after a donation is spent. It is verified on Giveth and is ChogCare's pilot initiative. The checkout shows whether payment processing is available.",
    raised: 2497.04,
    givethUrl: GIVETH_PROJECT_URL,
    live: true,
  },
  {
    id: "school-supplies",
    name: "School Supplies & Crypto Education",
    category: "Education",
    location: "Nigeria",
    image: "https://giveth.mypinata.cloud/ipfs/QmfZ6YaqHL6FnS3WSXrhAZv1ukahK4JUacZvX7phofqiFg",
    imageAlt: "Basic school supplies and crypto education initiative on Giveth",
    summary: "Helps children in Nigeria stay in school with essential learning supplies. The initiative also teaches communities how to use cryptocurrency.",
    cardSummary: "School supplies for children in Nigeria, alongside community crypto education.",
    details: "Basic school supplies and crypto education initiative is a verified Giveth project by Helpers Social Development Foundation. It brings together school supplies and crypto education. The foundation supports access to education for vulnerable children in Nigeria. Explore its project page for updates and donation history. ChogCare supports $CHOG donations and NFT-pool grants; checkout checks the worker, funds and current quote before issuing a QR.",
    raised: 9516.85,
    givethUrl: "https://giveth.io/project/basic-school-supplies-and-crypto-education-initiative?tab=donations",
    live: true,
  },
  {
    id: "vida-verde",
    name: "+Vida +Verde Venezuela",
    category: "Nature",
    location: "Venezuela",
    image: "https://giveth.mypinata.cloud/ipfs/QmcStBE4boayqj8rweKLikbBVyesDxfkDharb3V8rT7mQP",
    imageAlt: "The Vida Verde environmental community in Venezuela",
    summary: "A Venezuelan collective restoring the local environment through community action, environmental education and art near Caracas.",
    cardSummary: "Community-led environmental restoration, education and art near Caracas.",
    details: "+Vida +Verde is a Venezuelan collective using education, art and community action to restore the environment. Its work is rooted in a rural area near Caracas and turns local participation into practical conservation. The project is verified on Giveth and regularly publishes updates.",
    raised: 3965.65,
    givethUrl: "https://giveth.io/project/vida-verde-venezuela",
    live: true,
  },
  {
    id: "solar-foundation",
    name: "The Solar Foundation",
    category: "Clean energy",
    location: "Global",
    image: "/solar-foundation-community.jpg",
    imageAlt: "Community members holding solar-powered lights from The Solar Foundation",
    summary: "Funds off-grid solar power and useful appliances in underserved communities, helping people rely less on kerosene and diesel.",
    cardSummary: "Off-grid solar power and practical appliances for underserved communities.",
    details: "The Solar Foundation funds access to off-grid solar energy and productive appliances for underserved communities in emerging markets. It works with local organizations to support reliable power for schools, community spaces and farming projects, reducing reliance on kerosene and diesel. The project is verified on Giveth. ChogCare supports $CHOG donations and NFT-pool grants when the payment worker is ready.",
    raised: 6587.22,
    givethUrl: "https://giveth.io/project/the-solar-foundation?tab=donations",
    live: true,
  },
  {
    id: "animal-ethics",
    name: "Animal Ethics",
    category: "Animals",
    location: "Global",
    image: "/animal-ethics-mark.png",
    imageAlt: "Animal Ethics logo",
    summary: "Researches animal suffering and shares practical knowledge about helping animals, including those living in the wild. Supports education and public outreach.",
    cardSummary: "Research and education to reduce animal suffering, including in the wild.",
    details: "Animal Ethics works through research, education and public outreach to reduce animal suffering, including suffering in the wild. ChogCare exchanges $CHOG into the organization's accepted donation currency and delivers it to its published address. The checkout verifies the donation receipt before showing success. This is an independent organization, not a Giveth-listed initiative or a ChogCare partner.",
    raised: null,
    external: false,
    externalLabel: "Official donation instructions",
    givethUrl: "https://www.animal-ethics.org/cryptocurrencies/",
    live: true,
    holderLive: false,
  },
];

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function CauseImage({ initiative }: { initiative: Initiative }) {
  const [failed, setFailed] = useState(false);
  return <span className={`care-cause-visual${initiative.id === "animal-ethics" ? " is-artwork" : ""}`}>
    {failed ? <span className="care-cause-image-fallback">{initiative.name}</span> :
      <img src={initiative.image} alt={initiative.imageAlt} loading="lazy" decoding="async" width="640" height="280" onError={() => setFailed(true)} />}
  </span>;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Brand({ footer = false, onHome }: { footer?: boolean; onHome?: () => void }) {
  return <a href="#top" onClick={event => { if (onHome) { event.preventDefault(); onHome(); } }} className={`brand${footer ? " footer-brand" : ""}`} aria-label="ChogCare home">
    {footer ? <img className="care-brand-icon" src="/chogcare-care-logo.png" srcSet="/chogcare-care-logo-128.webp 128w, /chogcare-care-logo-256.webp 256w" sizes="62px" loading="lazy" decoding="async" width="1254" height="1254" alt="ChogCare logo" /> : <>
      <img className="care-header-icon" src="/chogcare-care-logo.png" srcSet="/chogcare-care-logo-128.webp 128w, /chogcare-care-logo-256.webp 256w" sizes="42px" decoding="async" fetchPriority="low" width="1254" height="1254" alt="" />
      <img className="care-header-wordmark" src="/chogcare-wordmark.png" srcSet="/chogcare-wordmark.webp 610w" sizes="(max-width: 767px) 137px, 180px" decoding="async" width="610" height="200" alt="ChogCare" />
    </>}
  </a>;
}

function Funding({ initiative }: { initiative: Initiative }) {
  if (initiative.raised === null) return null;
  return <div className="lp-funding">
    <div><span>Recorded on Giveth<strong>{money.format(initiative.raised)}</strong></span><span className="lp-target-pending">Fundraising target<strong>Not confirmed</strong></span></div>
  </div>;
}

const configuredTwitchChannel = import.meta.env.VITE_TWITCH_CHANNEL?.trim().toLowerCase() || "";
const twitchChannel = /^[a-z0-9_]{4,25}$/.test(configuredTwitchChannel) ? configuredTwitchChannel : null;
function owncastStreamUrl() {
  return broadcastStreamUrl(import.meta.env.VITE_OWNCAST_URL?.trim(), window.location.origin, window.matchMedia("(max-width: 767px), (pointer: coarse)").matches);
}

function NativeLivePlayer({ src, onReady, onWaiting, onAspect }: { src: string; onReady: () => void; onWaiting: () => void; onAspect: (ratio: number | undefined) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onReady, onWaiting, onAspect });
  const playAction = useRef<(() => void) | null>(null);
  const [loadState, setLoadState] = useState<LiveLoadState>("loading");
  const [hasFrame, setHasFrame] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [inView, setInView] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const preview = broadcastPreviewUrl(src, window.location.origin);

  useEffect(() => { callbacks.current = { onReady, onWaiting, onAspect }; }, [onReady, onWaiting, onAspect]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const video: HTMLVideoElement = element;
    let cancelled = false, inViewport = true, generation = 0;
    let segmentSeconds = src.endsWith("/hls/mobile/stream.m3u8") ? 1 : DEFAULT_LIVE_SEGMENT_SECONDS;
    let hls: HlsType | null = null, nativeActive = false;
    const nativeHlsCapable = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    const managedMediaSource = "ManagedMediaSource" in window;
    video.defaultMuted = true;
    video.muted = true;
    video.playsInline = true;
    setLoadState("loading"); setHasFrame(false); setPreviewReady(false); setInView(true);
    callbacks.current.onWaiting();
    const active = () => {
      if (cancelled || document.hidden || !inViewport || navigator.onLine === false) return false;
      const box = video.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
    };
    const liveStatus = createLivePlaybackStatus({ onChange: live => {
      if (!cancelled) { if (live) callbacks.current.onReady(); else callbacks.current.onWaiting(); }
    } });
    const loadMonitor = createLiveLoadState({ onChange: state => {
      if (cancelled) return;
      setLoadState(state);
      if (state === "blocked" || state === "unavailable") liveStatus.unavailable();
    } });
    const resumeSync = createLiveResumeSync({ media: video, segmentSeconds: () => segmentSeconds, liveSyncPosition: () => hls?.liveSyncPosition ?? null });
    const driftSync = createLiveDriftSync({ media: video, active: () => nativeActive && active(), segmentSeconds: () => segmentSeconds });
    const updateAspect = () => {
      if (!cancelled && video.videoWidth > 0 && video.videoHeight > 0) callbacks.current.onAspect(portraitFrameAspect(video.videoWidth, video.videoHeight));
    };
    const playback = createLivePlaybackRecovery({
      media: video, active, monitor: loadMonitor,
      resumeLoading: () => {
        // Restarting an active loader aborts its in-flight fragment request.
        // A scroll return or watchdog nudge must leave a healthy load alone.
        if (hls?.levels.length && !hls.loadingEnabled) hls.startLoad(-1, true);
        resumeSync.request();
      },
      reconnect: () => { if (nativeActive) startNative(); else installHls(); },
      onPlaying: () => {
        if (cancelled) return;
        updateAspect(); setHasFrame(true);
        if (nativeActive) driftSync.start();
        liveStatus.playing();
      },
      onWaiting: () => { if (!cancelled) liveStatus.waiting(); },
    });
    const startPlayback = () => playback.play();
    playAction.current = () => playback.play(true);
    const waiting = () => playback.waiting();
    const playing = () => playback.playing();
    const progress = () => playback.progress();
    const pausedPlayback = () => playback.paused();
    const endedPlayback = () => playback.recover(undefined, true);
    const metadata = () => { updateAspect(); resumeSync.update(); startPlayback(); };
    const canPlay = () => {
      resumeSync.update();
      if (video.paused) startPlayback();
    };
    const suspendPlayback = () => { playback.suspend(); liveStatus.suspend(); };
    const visibility = () => { if (document.hidden) suspendPlayback(); else playback.resume(); };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) playback.resume(); };
    const online = () => playback.resume();
    const offline = () => { suspendPlayback(); liveStatus.unavailable(); };
    const nativeError = () => playback.recover(undefined, true);

    function startNative() {
      if (cancelled || !nativeHlsCapable) return;
      generation++; playback.resetSource();
      setHasFrame(false); setPreviewReady(false);
      hls?.destroy(); hls = null; nativeActive = true;
      video.src = src; video.load(); waiting(); startPlayback();
    }
    function installHls() {
      if (cancelled) return;
      const current = ++generation;
      playback.resetSource();
      setHasFrame(false); setPreviewReady(false);
      hls?.destroy(); hls = null; nativeActive = false;
      video.removeAttribute("src"); video.load(); waiting();
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelled || current !== generation) return;
        const strategy = livePlaybackStrategy(Hls.isSupported(), nativeHlsCapable, managedMediaSource);
        if (strategy !== "hls") { if (strategy === "native") startNative(); else playback.unavailable(); return; }
        const engine = new Hls(liveHlsConfig());
        hls = engine;
        engine.on(Hls.Events.MANIFEST_PARSED, () => { if (hls === engine && !cancelled) startPlayback(); });
        engine.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
          if (hls !== engine || cancelled) return;
          segmentSeconds = liveSegmentSeconds(data.details.targetduration);
          if (active()) resumeSync.update();
        });
        engine.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || hls !== engine || cancelled) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) playback.recover(() => {
            if (hls === engine) { recoverLiveNetwork(engine, src, data.details); startPlayback(); }
          }, true);
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) playback.recover(() => {
            if (hls === engine) { engine.recoverMediaError(); startPlayback(); }
          }, true);
          else playback.recover(undefined, true);
        });
        engine.attachMedia(video); engine.loadSource(src);
      }).catch(() => {
        if (cancelled || current !== generation) return;
        if (nativeHlsCapable) startNative(); else playback.recover();
      });
    }

    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("loadeddata", updateAspect);
    video.addEventListener("resize", updateAspect);
    video.addEventListener("playing", playing);
    video.addEventListener("timeupdate", progress);
    video.addEventListener("pause", pausedPlayback);
    video.addEventListener("ended", endedPlayback);
    video.addEventListener("waiting", waiting);
    video.addEventListener("stalled", waiting);
    video.addEventListener("canplay", canPlay);
    video.addEventListener("error", nativeError);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === video);
      if (!entry || cancelled) return;
      const visible = entry.isIntersecting && entry.intersectionRatio > 0;
      if (visible === inViewport) return;
      inViewport = visible;
      setInView(inViewport);
      if (inViewport) playback.resume(); else suspendPlayback();
    }, { threshold: [0, 0.01] }) : null;
    observer?.observe(video);

    // Safari's native player starts without downloading the MSE engine.
    if (livePlaybackStrategy(typeof window.MediaSource === "function" || managedMediaSource, nativeHlsCapable, managedMediaSource) === "native") startNative();
    else installHls();

    return () => {
      cancelled = true; generation++; playAction.current = null;
      observer?.disconnect(); playback.dispose(); loadMonitor.dispose(); liveStatus.dispose();
      resumeSync.dispose(); driftSync.dispose();
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("loadeddata", updateAspect);
      video.removeEventListener("resize", updateAspect);
      video.removeEventListener("playing", playing);
      video.removeEventListener("timeupdate", progress);
      video.removeEventListener("pause", pausedPlayback);
      video.removeEventListener("ended", endedPlayback);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("stalled", waiting);
      video.removeEventListener("canplay", canPlay);
      video.removeEventListener("error", nativeError);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      hls?.destroy(); video.pause(); video.removeAttribute("src"); video.load();
    };
  }, [src, attempt]);

  return <>
    {preview && !hasFrame && <BroadcastPreview key={preview} src={preview} refresh={inView && (loadState === "loading" || loadState === "unavailable")}
      onReady={() => setPreviewReady(true)}
      onAspect={(width, height) => callbacks.current.onAspect(portraitFrameAspect(width, height))} />}
    <video ref={videoRef} className="lp-broadcast-player is-ready" autoPlay muted playsInline preload="auto"
      disableRemotePlayback disablePictureInPicture controls={false}
      controlsList="nodownload noplaybackrate noremoteplayback" tabIndex={-1}
      aria-label="ChogCare live broadcast" onContextMenu={(event) => event.preventDefault()} />
    {loadState !== "playing" && !((hasFrame || previewReady) && loadState === "loading") && <div className="lp-broadcast-loading lp-broadcast-state" role="status" aria-live="polite">
      {loadState === "loading" ? <><i aria-hidden="true"/><span>Loading live broadcast…</span></> : <>
        <span className="care-broadcast-state-icon" aria-hidden="true"><Broadcast size={30} weight="light" /></span>
        <strong>{loadState === "blocked" ? "Ready when you are." : "Reconnecting broadcast"}</strong>
        <span>{loadState === "blocked" ? "Your browser needs a tap to start the video." : "The connection was interrupted. Retrying automatically."}</span>
        <button type="button" onClick={() => { if (loadState === "blocked") playAction.current?.(); else setAttempt(value => value + 1); }}>{loadState === "blocked" ? "Play broadcast" : "Retry broadcast"}</button>
      </>}
    </div>}
  </>;
}

function BroadcastPanel({ headingId, portraitAspect, onAspect }: { headingId: string; portraitAspect: number | undefined; onAspect: (ratio: number | undefined) => void }) {
  const [playerLoaded, setPlayerLoaded] = useState(false);
  useEffect(() => {
    if (!playerLoaded) return;
    const timer = setTimeout(() => { void loadPaymentCheckout().catch(() => {}); }, 1500);
    return () => clearTimeout(timer);
  }, [playerLoaded]);
  const owncastUrl = owncastStreamUrl();
  const twitchUrl = twitchChannel
    ? `https://player.twitch.tv/?channel=${encodeURIComponent(twitchChannel)}&parent=${encodeURIComponent(window.location.hostname)}&muted=true&autoplay=true`
    : null;

  return <div className="care-stream" data-camera-fit={portraitAspect ? "portrait" : "fallback"} style={portraitAspect ? { aspectRatio: portraitAspect } : undefined}>
    <section className="lp-broadcast-frame" aria-labelledby={headingId}>
      <div className="lp-broadcast-interior">
        {owncastUrl || twitchUrl ? <>
          <h2 id={headingId} className="sr-only">ChogCare live broadcast</h2>
          {owncastUrl ? <NativeLivePlayer src={owncastUrl} onReady={() => setPlayerLoaded(true)} onWaiting={() => setPlayerLoaded(false)} onAspect={onAspect} /> : <iframe
              className={`lp-broadcast-player${playerLoaded ? " is-ready" : ""}`}
              src={twitchUrl ?? undefined}
              title="ChogCare live broadcast"
              loading="eager"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              onLoad={() => setPlayerLoaded(true)}
            />}
          <span className={`lp-broadcast-live${playerLoaded ? "" : " is-waiting"}`} role="status" aria-label={playerLoaded ? "Live broadcast" : "Broadcast not playing"}>
            <i aria-hidden="true" />{playerLoaded ? "LIVE" : "STREAM"}
          </span>
          {!owncastUrl && <span className={`lp-broadcast-loading${playerLoaded ? " is-hidden" : ""}`} aria-hidden="true">
            <i />Loading live broadcast…
          </span>}
        </> : <div className="lp-broadcast-placeholder">
          <Broadcast size={38} weight="light" aria-hidden="true" />
          <h2 id={headingId}>ChogCare broadcast</h2>
          <p>Coming soon</p>
        </div>}
      </div>
    </section>
  </div>;
}

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const bridgeRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [support, setSupport] = useState<SupportContext | null>(null);
  const [initialSelection] = useState(() => {
    try { return checkoutSelection(); }
    catch { return { mode: "chog" as const, initiativeId: "burundi", outstanding: true }; }
  });
  const [mode, setMode] = useState<"nft" | "chog">(initialSelection.mode);
  const [stationOpen, setStationOpen] = useState(initialSelection.outstanding);
  const [checkoutVisited, setCheckoutVisited] = useState(initialSelection.outstanding);
  useEffect(() => { if (stationOpen) setCheckoutVisited(true); }, [stationOpen]);
  const [exitTarget, setExitTarget] = useState<string | null>(null);
  const [returnedToLanding, setReturnedToLanding] = useState(false);
  // Keep the observed camera ratio across checkout navigation so its delayed
  // metadata cannot resize the hero and shift the destination after returning.
  const [portraitAspect, setPortraitAspect] = useState<number | undefined>();
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [resumeNotice, setResumeNotice] = useState(false);
  const stationRef = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState(initialSelection.initiativeId);
  const [openInitiative, setOpenInitiative] = useState<Initiative | null>(null);
  const token = import.meta.env.VITE_CHOG_TOKEN_ADDRESS || "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
  const selected = initiatives.find(item => item.id === selectedId) ?? initiatives[0];
  useGSAP(() => {
    // Returning from checkout is navigation, not a fresh entrance. The previous
    // context has reverted, so every landing panel is already fully visible.
    if (stationOpen || returnedToLanding || !appRef.current) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const hero = heroRef.current;
      if (hero && hero.getBoundingClientRect().bottom > 0) {
        gsap.from(".care-intro-copy > *", { y: 20, opacity: 0, duration: .85, stagger: .09, ease: "power3.out", clearProps: "opacity,transform" });
        // The camera is immediately visible; an entrance fade delays the first
        // useful frame even after the network has already delivered it.
      }
      const stage = appRef.current!.querySelector(".care-lower-stage");
      const block = appRef.current!.querySelector(".care-lower-world");
      if (stage && block) {
        const reveal = gsap.timeline({ defaults: { ease: "power3.out" }, scrollTrigger: { trigger: stage, start: "clamp(top 95%)", once: true } });
        // Move the complete panel together. Never hide its content behind an
        // already opaque, full-page surface, even during a fast anchor jump.
        reveal.from(block, { y: 24, duration: .65, clearProps: "transform" }, 0);
      }
      gsap.from(".care-support-strip", { y: 18, duration: .55, ease: "power3.out", clearProps: "transform", scrollTrigger: { trigger: ".care-support-strip", start: "clamp(top 95%)", once: true } });
    }, appRef);
    return () => media.revert();
  }, { scope: appRef, dependencies: [stationOpen, returnedToLanding], revertOnUpdate: true });
  const leaveStation = (target: string) => {
    if (exitTarget) return;
    if (!stationOpen) {
      window.location.hash = target;
      document.getElementById(target)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
      return;
    }
    setExitTarget(target);
  };
  useEffect(() => {
    if (!exitTarget) return;
    let active = true;
    const transition = transitionLanding(() => flushSync(() => {
      // Update the URL without letting native anchor scrolling race the still
      // hidden destination. The layout effect positions it before first paint.
      window.history.pushState(window.history.state, "", `#${exitTarget}`);
      setReturnedToLanding(true);
      setStationOpen(false);
    }));
    void transition.finished.then(() => { if (active) setExitTarget(null); });
    return () => { active = false; transition.cancel(); };
  }, [exitTarget]);
  useEffect(() => {
    const changed = () => {
      try {
        const saved = checkoutSelection(selectedId, mode);
        if (saved.outstanding) { setSelectedId(saved.initiativeId); setMode(saved.mode); }
        else { setResumeNotice(false); }
      } catch { setResumeNotice(true); }
    };
    window.addEventListener(checkoutChanged, changed);
    return () => window.removeEventListener(checkoutChanged, changed);
  }, [selectedId, mode]);
  useLayoutEffect(() => {
    if (stationOpen) {
      stationRef.current?.focus({ preventScroll: true });
      stationRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    } else {
      // Reveal and position the destination in one painted frame: a passive
      // effect allows the hero to flash before this scroll on checkout return.
      const target = window.location.hash.slice(1);
      if (["top", "causes", "how-it-works", "leaderboard"].includes(target)) {
        document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "instant" });
        if (returnedToLanding) document.getElementById(target)?.focus({ preventScroll: true });
        window.dispatchEvent(new Event(landingPositioned));
      }
    }
  }, [stationOpen, selectedId, returnedToLanding]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (openInitiative && dialog && !dialog.open) dialog.showModal();
    if (!openInitiative && dialog?.open) dialog.close();
  }, [openInitiative]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setCopyError(false);
    } catch { setCopyError(true); }
  };

  const chooseCause = (id: string) => {
    // Never relabel an outstanding payment when browsing another initiative.
    try {
      const saved = checkoutSelection(id, mode);
      setSelectedId(saved.initiativeId);
      setResumeNotice(saved.outstanding && id !== saved.initiativeId);
      setMode(saved.mode);
    } catch { setSelectedId("burundi"); setResumeNotice(true); }
    setOpenInitiative(null);
    setExitTarget(null);
    setReturnedToLanding(false);
    setStationOpen(true);
    window.location.hash = "station";
  };
  const chooseMode = (requested: "chog" | "nft") => {
    try {
      const saved = checkoutSelection(selectedId, requested);
      setSelectedId(saved.initiativeId); setMode(saved.mode); rememberMode(saved.mode);
      setResumeNotice(saved.outstanding && requested !== saved.mode);
      return saved.mode;
    } catch { setResumeNotice(true); return mode; }
  };

  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className={`site-frame app-layout landing-page sunset-page${stationOpen ? " has-open-checkout" : ""}`} id="top" ref={appRef} tabIndex={-1}>
      <header className="site-header">
        <div className="care-header-inner">
        <Brand onHome={() => leaveStation("top")} />
        <nav className="care-header-nav" aria-label="Main navigation">
          <a href="#causes" onClick={event => { event.preventDefault(); leaveStation("causes"); }}>Causes</a>
          <a href="#how-it-works" onClick={event => { event.preventDefault(); leaveStation("how-it-works"); }}>How it works</a>
          <a href="#leaderboard" onClick={event => { event.preventDefault(); leaveStation("leaderboard"); }}>Leaderboard</a>
        </nav>
        <div className="creator"><img src="/gx-avatar.png" srcSet="/gx-avatar-128.webp 128w" sizes="36px" decoding="async" fetchPriority="low" alt="GX avatar" width="36" height="36" /><span><small>Creator</small>GX</span><a className="creator-x" href="https://x.com/GxOlympus" target="_blank" rel="noopener noreferrer" aria-label="GX on X (opens in a new tab)"><XLogo size={21} weight="bold" /></a></div>
        </div>
      </header>

      <main id="main" className="lp-main">
        <div hidden={stationOpen}>
          <section ref={heroRef} className="care-intro" aria-labelledby="hero-heading">
            <div className="care-intro-broadcast">{!stationOpen && <BroadcastPanel headingId="intro-broadcast-heading" portraitAspect={portraitAspect} onAspect={setPortraitAspect} />}</div>
            <div className="care-intro-copy">
              <h1 id="hero-heading">Your $CHOG.<br/><span>Real-world care.</span></h1>
              <p>Give to a cause. Watch the care station light up.</p>
              <div className="care-hero-actions"><a href="#causes" className="button primary">Choose a cause <ArrowRight size={20} /></a></div>
            </div>
            <div className="care-hero-signature" aria-label="$CHOG to charity">
              <span className="care-signature-line" aria-hidden="true"/>
              <span className="care-signature-path"><span>$CHOG</span><ArrowRight size={22} weight="bold" aria-hidden="true"/><span>CHARITY</span></span>
              <span className="care-signature-line" aria-hidden="true"/>
            </div>
          </section>

          <div ref={bridgeRef} className="care-scene-bridge" aria-hidden="true"/>
          <div className="care-lower-stage"><div className="care-lower-world"><div className="care-lower-content">
          <GivingExplainer />
          <section id="causes" tabIndex={-1} className="care-causes" aria-labelledby="causes-heading">
            <h2 id="causes-heading">Choose where <span>care goes.</span></h2>
            <p>One donation. A cause you believe in.</p>
            <div className="care-cause-buttons">
              {initiatives.filter(item => !item.archived).map(item => <button type="button" className={`care-cause-button${item.live ? " has-checkout" : ""}`} key={item.id} onClick={() => chooseCause(item.id)} aria-label={"Choose " + item.name} aria-describedby={`cause-status-${item.id}`}>
                <CauseImage initiative={item} />
                <span className="care-cause-body">
                  <span className="care-cause-meta"><span>{item.category}</span><span>{item.location}</span></span>
                  <strong>{item.name}</strong>
                  <span className="care-cause-summary">{item.cardSummary ?? item.summary}</span>
                  <span className="care-cause-bottom">
                    <span className="care-cause-action">Give with $CHOG <ArrowRight size={18} aria-hidden="true" /></span>
                    <span className="care-cause-status" id={`cause-status-${item.id}`}>{item.live ? item.holderLive===false ? "$CHOG donation" : "$CHOG · NFT holder" : "Payments under review"}</span>
                  </span>
                </span>
              </button>)}
            </div>
          </section>
          </div></div></div>
          {!stationOpen && <Leaderboard/>}
        </div>

        <section id="station" ref={stationRef} tabIndex={-1} hidden={!stationOpen} inert={exitTarget !== null} className={`care-station${exitTarget ? " is-leaving" : ""}`} aria-label="Broadcast and donation checkout">
          <div className="care-station-toolbar"><ChangeInitiative key={mode + recoveryVersion} mode={mode} onChange={() => { setRecoveryVersion(value => value + 1); setResumeNotice(false); leaveStation("causes"); }}/></div>
          {resumeNotice && <p className="care-resume-note" role="status">This checkout keeps its original initiative: {selected.name}. Switching methods never replaces a saved invoice.</p>}
          <div className="care-station-grid">
            <div className="care-stream-column" id="care-livestream" tabIndex={-1}>
              <div className="care-station-stream-heading"><h3>Care station</h3><p>The broadcast stays here while you give.</p></div>
              {stationOpen && <BroadcastPanel headingId="broadcast-heading" portraitAspect={portraitAspect} onAspect={setPortraitAspect} />}
            </div>
            <div className="care-checkout-column">
              <div className="care-selected"><img src={selected.image} alt={selected.imageAlt} loading="lazy" width="76" height="76" /><div><span>{selected.category} · {selected.location}</span><h2>{selected.name}</h2><button className="lp-text-button" onClick={() => setOpenInitiative(selected)}>About this initiative <ArrowUpRight size={14} /></button></div></div>
            <div className="lp-payment">
              <div className="lp-payment-tabs" role="tablist" aria-label="Donation method">{(["chog", "nft"] as const).map((item, index) => <button key={item} id={"tab-" + item} role="tab" aria-controls={"panel-" + item} aria-selected={mode === item} tabIndex={mode === item ? 0 : -1} onClick={() => chooseMode(item)} onKeyDown={event => {
                if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "chog" : event.key === "End" ? "nft" : index === 0 ? "nft" : "chog"; document.getElementById("tab-" + chooseMode(next))?.focus(); }
              }}><img className={`payment-tab-art ${item === "chog" ? "payment-tab-coin" : "payment-tab-nft"}`} src={item === "chog" ? "/chog-donation-coin.png" : "/chog-holder-nft.png"} srcSet={item === "chog" ? "/chog-donation-coin-256.webp 256w" : "/chog-holder-nft-256.webp 256w"} sizes="32px" loading="lazy" alt="" width="32" height="32"/><span className="payment-tab-copy"><strong>{item === "chog" ? "$CHOG" : "NFT holder"}</strong><small>{item === "chog" ? "Your amount" : "$1 from pool"}</small></span></button>)}</div>
              <CheckoutSizeTransition>
              <div id="panel-chog" role="tabpanel" aria-labelledby="tab-chog" hidden={mode !== "chog"}>
                {(stationOpen || checkoutVisited) && mode === "chog" && <PaymentCheckout key={selectedId + "-chog-" + recoveryVersion} mode="chog" initiativeId={selectedId} initiativeName={selected.name} onViewLeaderboard={()=>leaveStation("leaderboard")} />}
              </div>
              <div id="panel-nft" role="tabpanel" aria-labelledby="tab-nft" hidden={mode !== "nft"}>
                {(stationOpen || checkoutVisited) && mode === "nft" && <PaymentCheckout key={selectedId + "-nft-" + recoveryVersion} mode="nft" initiativeId={selectedId} initiativeName={selected.name} />}
              </div>
              </CheckoutSizeTransition>
            </div>
            <CheckoutRecovery onRestore={() => { setRecoveryVersion(version=>version+1); setResumeNotice(true); }}/>
            </div>
          </div>
        </section>


        <section className="care-support-strip" hidden={stationOpen} aria-labelledby="support-heading"><div className="care-support-symbol"><ChatCircle size={34} weight="duotone"/></div><div><span>We’re here to help</span><h2 id="support-heading">A little help, when you need it.</h2><p>Questions about a donation? Write to ChogCare.</p></div><button type="button" className="care-support-button" onClick={() => setSupport({})}><ChatCircle size={20}/>Support<ArrowUpRight size={20}/></button></section>

      </main>
      <SunsetScene checkout={stationOpen} heroRef={heroRef} bridgeRef={bridgeRef}/>

      <footer className="lp-footer"><div className="lp-footer-top"><Brand footer onHome={() => leaveStation("top")} /><p>An independent community project.<br />Built for Chogathon 2026.</p><a href="https://giveth.io/" target="_blank" rel="noreferrer">Explore Giveth <ArrowUpRight size={16} /></a></div><div className="lp-footer-bottom"><span>© 2026 ChogCare · Created by GX</span><button onClick={copyToken} aria-label="Copy $CHOG token address">$CHOG <span>{shortAddress(token)}</span>{copied ? <Check size={16} /> : <Copy size={16} />}<span aria-live="polite">{copied ? "Copied" : ""}</span></button><a href="#top" onClick={event => { event.preventDefault(); leaveStation("top"); }}>Back to top ↑</a></div>{copyError && <p className="copy-error">Copy manually: {token}</p>}</footer>
    </div>

    <dialog ref={dialogRef} className="lp-project-dialog" onCancel={() => setOpenInitiative(null)} onClose={() => setOpenInitiative(null)} onClick={event => { if (event.target === event.currentTarget) setOpenInitiative(null); }} aria-labelledby="project-dialog-title">
      {openInitiative && <article>
        <div className="lp-dialog-tools"><button className="lp-dialog-close" onClick={() => setOpenInitiative(null)} aria-label="Close project details" autoFocus><X size={22} /></button></div>
        <img src={openInitiative.image} alt={openInitiative.imageAlt} width="640" height="350" />
        <div className="lp-dialog-content"><span className="lp-label">{openInitiative.category} · {openInitiative.location}</span><h2 id="project-dialog-title">{openInitiative.name}</h2><p>{openInitiative.details}</p>
          <Funding initiative={openInitiative} />
          {openInitiative.raised!==null&&<p className="lp-data-note">Historical Giveth snapshot. The current fundraising target has not been confirmed.</p>}
          <div className="lp-dialog-actions">
            {!openInitiative.external&&<a className="button primary" href="#station" onClick={() => chooseCause(openInitiative.id)}>{openInitiative.live ? "Donate" : "View donation options"} <ArrowRight size={17} /></a>}
            <a className={openInitiative.external ? "button primary" : "lp-text-button"} href={openInitiative.givethUrl} target="_blank" rel="noopener noreferrer">{openInitiative.externalLabel ?? (openInitiative.external ? "Official donation page" : "View on Giveth")} <ArrowUpRight size={16} /></a>
          </div>
        </div>
      </article>}
    </dialog>
    <SupportDialog context={support} onClose={() => setSupport(null)}/>
  </>;
}
