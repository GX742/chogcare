import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Broadcast, X, XLogo } from "@phosphor-icons/react";
import PaymentCheckout from "./PaymentCheckout";
import HeartField from "./HeartField";
import { GIVETH_PROJECT_URL } from "./route";
import { checkoutChanged, checkoutSelection, rememberMode } from "./checkout-session";
import CheckoutRecovery from "./CheckoutRecovery";
import CheckoutSizeTransition from "./CheckoutSizeTransition";

import "./station-redesign.css";

type Initiative = {
  id: string;
  name: string;
  category: string;
  location: string;
  image: string;
  imageAlt: string;
  summary: string;
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
    details: "Basic school supplies and crypto education initiative is a verified Giveth project by Helpers Social Development Foundation. It brings together school supplies and crypto education. The foundation supports access to education for vulnerable children in Nigeria. Explore its project page for updates and donation history. ChogCare supports CHOG donations and NFT-pool grants; checkout checks the worker, funds and current quote before issuing a QR.",
    raised: 9516.85,
    givethUrl: "https://giveth.io/project/basic-school-supplies-and-crypto-education-initiative?tab=donations",
    live: true,
  },
  {
    id: "solar-foundation",
    name: "The Solar Foundation",
    category: "Clean energy",
    location: "Global",
    image: "https://giveth.mypinata.cloud/ipfs/QmccBU7Xwx4cjAgrArNT9TVRffGDnaZpxgRZynrZq3bhs2",
    imageAlt: "The Solar Foundation project on Giveth",
    summary: "Funds off-grid solar power and useful appliances in underserved communities, helping people rely less on kerosene and diesel.",
    details: "The Solar Foundation funds access to off-grid solar energy and productive appliances for underserved communities in emerging markets. It works with local organizations to support reliable power for schools, community spaces and farming projects, reducing reliance on kerosene and diesel. The project is verified on Giveth. ChogCare supports CHOG donations and NFT-pool grants when the payment worker is ready.",
    raised: 6587.22,
    givethUrl: "https://giveth.io/project/the-solar-foundation?tab=donations",
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
    details: "+Vida +Verde is a Venezuelan collective using education, art and community action to restore the environment. Its work is rooted in a rural area near Caracas and turns local participation into practical conservation. The project is verified on Giveth and regularly publishes updates.",
    raised: 3965.65,
    givethUrl: "https://giveth.io/project/vida-verde-venezuela",
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
    details: "Animal Ethics works through research, education and public outreach to reduce animal suffering, including suffering in the wild. ChogCare exchanges CHOG and delivers native SOL to the organization's published Solana address. The checkout verifies the signed route and finalized Solana receipt before showing success. This is an independent organization, not a Giveth-listed initiative or a ChogCare partner.",
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
    <img src="/chogcare-sunset.png" width="64" height="64" alt="ChogCare logo" />
    <span className="brand-titles"><span className="brand-name">Chog<span className="brand-care">Care</span></span><span className="brand-collab"><span aria-label="in collaboration with">×</span><span className="collab-name">Chogathon 2026</span></span></span>
  </a>;
}

function Funding({ initiative }: { initiative: Initiative }) {
  if (initiative.raised === null) return null;
  return <div className="lp-funding">
    <div><span>Recorded on Giveth<strong>{money.format(initiative.raised)}</strong></span><span className="lp-target-pending">Fundraising target<strong>Not confirmed</strong></span></div>
  </div>;
}

const configuredTwitchChannel = import.meta.env.VITE_TWITCH_CHANNEL?.trim().toLowerCase() || "nerfwok";
const twitchChannel = /^[a-z0-9_]{4,25}$/.test(configuredTwitchChannel) ? configuredTwitchChannel : null;

function BroadcastPanel({ headingId }: { headingId: string }) {
  return <div className="care-stream">
    <section className="lp-broadcast-frame" aria-labelledby={headingId}>
      <div className="lp-broadcast-interior">
        {twitchChannel ? <>
          <h2 id={headingId} className="sr-only">ChogCare live broadcast</h2>
          <iframe
            className="lp-broadcast-player"
            src={`https://player.twitch.tv/?channel=${encodeURIComponent(twitchChannel)}&parent=${encodeURIComponent(window.location.hostname)}&muted=true&autoplay=true`}
            title="ChogCare live broadcast"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
          <span className="lp-broadcast-live" aria-hidden="true"><i />Live</span>
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [initialSelection] = useState(() => {
    try { return checkoutSelection(); }
    catch { return { mode: "chog" as const, initiativeId: "burundi", outstanding: true }; }
  });
  const [mode, setMode] = useState<"nft" | "chog">(initialSelection.mode);
  const [stationOpen, setStationOpen] = useState(initialSelection.outstanding);
  const [exitTarget, setExitTarget] = useState<string | null>(null);
  const [returnedToLanding, setReturnedToLanding] = useState(false);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [resumeNotice, setResumeNotice] = useState(false);
  const stationRef = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState(initialSelection.initiativeId);
  const [openInitiative, setOpenInitiative] = useState<Initiative | null>(null);
  const token = import.meta.env.VITE_CHOG_TOKEN_ADDRESS || "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
  const selected = initiatives.find(item => item.id === selectedId) ?? initiatives[0];
  const leaveStation = (target: string) => {
    if (!stationOpen) {
      window.location.hash = target;
      document.getElementById(target)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
      return;
    }
    setExitTarget(target);
  };
  useEffect(() => {
    if (!exitTarget) return;
    const finish = () => {
      window.location.hash = exitTarget;
      setReturnedToLanding(true);
      setStationOpen(false);
      setExitTarget(null);
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) { finish(); return; }
    const timer = window.setTimeout(finish, 220);
    return () => window.clearTimeout(timer);
  }, [exitTarget]);
  useEffect(() => {
    const changed = () => {
      try {
        const saved = checkoutSelection();
        if (saved.outstanding) { setSelectedId(saved.initiativeId); setMode(saved.mode); }
        else { setResumeNotice(false); }
      } catch { setResumeNotice(true); }
    };
    window.addEventListener(checkoutChanged, changed);
    return () => window.removeEventListener(checkoutChanged, changed);
  }, []);
  useEffect(() => {
    if (stationOpen) {
      stationRef.current?.focus({ preventScroll: true });
      stationRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    } else {
      // The destination was hidden until this render, so native hash scrolling
      // alone can run too early when returning from checkout.
      const target = window.location.hash.slice(1);
      if (["top", "causes", "how-it-works"].includes(target)) {
        document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "instant" });
        if (returnedToLanding) document.getElementById(target)?.focus({ preventScroll: true });
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
    <HeartField paused={false} />
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-frame app-layout landing-page" id="top" ref={appRef} tabIndex={-1}>
      <header className="site-header">
        <div className="care-header-inner">
        <Brand onHome={() => leaveStation("top")} />
        <nav aria-label="Main navigation">
          <a href="#causes" onClick={event => { event.preventDefault(); leaveStation("causes"); }}>The causes</a><a href="#how-it-works" onClick={event => { event.preventDefault(); leaveStation("how-it-works"); }}>How it works</a><a href="#causes" onClick={event => { event.preventDefault(); leaveStation("causes"); }} className="lp-nav-donate">Choose a cause <ArrowUpRight size={15} /></a>
        </nav>
        <div className="creator"><img src="/gx-avatar.png" alt="" width="36" height="36" /><span><small>CREATED BY</small>GX</span><a className="creator-x" href="https://x.com/GxOlympus" target="_blank" rel="noopener noreferrer" aria-label="GX on X (opens in a new tab)"><XLogo size={21} weight="bold" /></a></div>
        </div>
      </header>

      <main id="main" className="lp-main">
        <div hidden={stationOpen} className={returnedToLanding ? "care-landing-return" : undefined}>
          <section className="care-intro" aria-labelledby="hero-heading">
            <div className="care-intro-broadcast">{!stationOpen && <BroadcastPanel headingId="intro-broadcast-heading" />}</div>
            <div className="care-intro-copy">
              <h1 id="hero-heading">Donate with $CHOG.</h1>
              <p>Choose a charity and send CHOG by QR. ChogCare converts your donation to USDC and delivers it to the initiative.</p>
              <p className="care-intro-context">The broadcast and your payment stay side by side. No wallet connection to this site.</p>
              <a href="#causes" className="button primary">Choose a cause <ArrowRight size={20} /></a>
            </div>
          </section>

          <section id="how-it-works" tabIndex={-1} className="care-mechanics" aria-label="How ChogCare works">
            <article className="care-mechanic care-token-mechanic" aria-labelledby="token-mechanic-title">
              <div className="care-mechanic-art care-coin-art"><img src="/chog-donation-coin.png" alt="Purple CHOG coin" width="1324" height="1188" loading="lazy" /></div>
              <div className="care-mechanic-copy">
                <span className="care-mechanic-label">Give with CHOG</span>
                <h2 id="token-mechanic-title"><span>$CHOG</span><ArrowRight size={24} aria-hidden="true" />Charity</h2>
                <p>Send CHOG. We exchange and bridge it.<br />Your chosen initiative receives USDC.</p>
                <span className="care-mechanic-note">Your cause amount stays intact. 10% is added for the NFT community pool.</span>
              </div>
            </article>
            <article className="care-mechanic care-nft-mechanic" aria-labelledby="nft-mechanic-title">
              <div className="care-mechanic-art care-nft-art"><img src="/chog-holder-nft.png" alt="CHOG NFT with a blue hat and purple laser eyes" width="1000" height="1000" loading="lazy" /></div>
              <div className="care-mechanic-copy">
                <div className="care-mechanic-label-row"><span className="care-mechanic-label">For NFT holders</span><span className="care-soon">Daily pool</span></div>
                <h2 id="nft-mechanic-title" className="care-nft-title">$0.50<span>/ day</span></h2>
                <p>Hold a CHOG NFT. Choose a cause.<br />The pool donates on your behalf.</p>
                <span className="care-mechanic-note">Once per NFT, per UTC day. $10 daily pool.<br />Up to 20 claims, subject to available funds.</span>
              </div>
            </article>
          </section>

          <section className="care-giving-trust" aria-label="Transparent payment split and project sources">
            <div className="care-contribution-rule">
              <div className="care-trust-labels"><span>Transparent split</span><span>0% service fee</span></div>
              <strong>+10%</strong>
              <div><h2>One donation. More daily impact.</h2><p>Your cause amount stays intact. The extra 10% funds the NFT community pool.</p></div>
              <div className="care-split-meter" aria-label="100 percent to your cause plus 10 percent to the NFT pool"><span><b>100%</b> your cause</span><span><b>+10%</b> NFT pool</span></div>
            </div>
            <div className="care-source-list">
              <a className="care-source-row" href="https://giveth.io/" target="_blank" rel="noopener noreferrer"><img src="/giveth-mark.png" alt="" width="48" height="48" loading="lazy"/><span><small>Verified project pages</small><strong>Giveth-listed causes</strong></span><ArrowUpRight size={18}/></a>
              <a className="care-source-row" href="https://www.animal-ethics.org/cryptocurrencies/" target="_blank" rel="noopener noreferrer"><img className="is-animal" src="/animal-ethics-mark.png" alt="" width="48" height="48" loading="lazy"/><span><small>Official donation address</small><strong>Animal Ethics</strong></span><ArrowUpRight size={18}/></a>
            </div>
            <p className="care-giving-terms">Before the QR, you see the full CHOG total and live dollar estimate. Network costs still apply. NFT verification uses a separate 1 MON donation.</p>
          </section>
          <section id="causes" tabIndex={-1} className="care-causes" aria-labelledby="causes-heading">
            <h2 id="causes-heading">Choose your cause<span>.</span></h2>
            <p>Choose who you want to help. Your broadcast and donation options open together.</p>
            <div className="care-cause-buttons">
              {initiatives.filter(item => !item.archived).map(item => <button type="button" className={`care-cause-button${item.live ? " has-checkout" : ""}`} key={item.id} onClick={() => chooseCause(item.id)} aria-label={"Choose " + item.name} aria-describedby={`cause-status-${item.id}`}>
                <CauseImage initiative={item} />
                <span className="care-cause-body">
                  <span className="care-cause-meta"><span>{item.category}</span><span>{item.location}</span></span>
                  <strong>{item.name}</strong>
                  <span className="care-cause-summary">{item.summary}</span>
                  <span className="care-cause-bottom">
                    <span className="care-cause-action">Choose project <ArrowRight size={18} aria-hidden="true" /></span>
                    <span className="care-cause-status" id={`cause-status-${item.id}`}>{item.live ? item.holderLive===false ? "CHOG · SOL payout" : "CHOG · NFT holder" : "Payments under review"}</span>
                  </span>
                </span>
              </button>)}
            </div>
          </section>
        </div>

        <section id="station" ref={stationRef} tabIndex={-1} hidden={!stationOpen} inert={exitTarget !== null} className={`care-station${exitTarget ? " is-leaving" : ""}`} aria-label="Broadcast and donation checkout">
          <div className="care-station-toolbar"><button className="lp-text-button" onClick={() => leaveStation("causes")}><ArrowLeft size={17} /> Change initiative</button></div>
          {resumeNotice && <p className="care-resume-note" role="status">Your existing payment stays with {selected.name} and its original payment method. Resume it before starting another payment.</p>}
          <div className="care-station-grid">
            <div className="care-stream-column">
              {stationOpen && <BroadcastPanel headingId="broadcast-heading" />}
            </div>
            <div className="care-checkout-column">
              <div className="care-selected"><img src={selected.image} alt={selected.imageAlt} width="76" height="76" /><div><span>{selected.category} · {selected.location}</span><h2>{selected.name}</h2><button className="lp-text-button" onClick={() => setOpenInitiative(selected)}>About this initiative <ArrowUpRight size={14} /></button></div></div>
            <div className="lp-payment">
              <div className="lp-payment-tabs" role="tablist" aria-label="Donation method">{(["chog", "nft"] as const).map((item, index) => <button key={item} id={"tab-" + item} role="tab" aria-controls={"panel-" + item} aria-selected={mode === item} tabIndex={mode === item ? 0 : -1} onClick={() => chooseMode(item)} onKeyDown={event => {
                if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "chog" : event.key === "End" ? "nft" : index === 0 ? "nft" : "chog"; document.getElementById("tab-" + chooseMode(next))?.focus(); }
              }}>{item === "chog" ? <><img className="payment-tab-art payment-tab-coin" src="/chog-donation-coin.png" alt="" width="34" height="34"/> Give with CHOG</> : <><img className="payment-tab-art payment-tab-nft" src="/chog-holder-nft.png" alt="" width="32" height="32"/> NFT holder <small>$0.50</small></>}</button>)}</div>
              <CheckoutSizeTransition>
              <div id="panel-chog" role="tabpanel" aria-labelledby="tab-chog" hidden={mode !== "chog"}>
                {mode === "chog" && <PaymentCheckout key={selectedId + "-chog-" + recoveryVersion} mode="chog" initiativeId={selectedId} initiativeName={selected.name} />}
              </div>
              <div id="panel-nft" role="tabpanel" aria-labelledby="tab-nft" hidden={mode !== "nft"}>
                {mode === "nft" && <PaymentCheckout key={selectedId + "-nft-" + recoveryVersion} mode="nft" initiativeId={selectedId} initiativeName={selected.name} />}
              </div>
              </CheckoutSizeTransition>
            </div>
            <CheckoutRecovery onRestore={() => { setRecoveryVersion(version=>version+1); setResumeNotice(true); }}/>
            </div>
          </div>
        </section>

        <section className="lp-section lp-faq" hidden={stationOpen} aria-labelledby="faq-heading">
          <div><h2 id="faq-heading">Before you donate.</h2></div>
          <div className="lp-faq-list">
            <details><summary>Do I need a CHOG NFT to donate?<span>+</span></summary><p>No. Anyone can donate 300–1,000,000 CHOG when the processor is available. NFT holders can reserve a separate $0.50 pool donation when funded claims are open at checkout.</p></details>
            <details><summary>Do I need to connect my wallet?<span>+</span></summary><p>No connection to this website is required. Once payments are enabled, you will scan a payment QR or copy the dedicated deposit address and confirm a transfer inside your own wallet. Never share your private key or seed phrase.</p></details>
            <details><summary>How does NFT verification work?<span>+</span></summary><p>Enter the wallet address holding your CHOG NFT. We find the NFT automatically. When the pool is ready, reserve $0.50 and send exactly 1 MON once to your single-use verification address on Monad. Use your NFT holder wallet, not an exchange. The 1 MON is a non-refundable donation held by ChogCare, separate from wallet gas. After verifying the transfer and ownership, the pool sends 0.50 USDC to the initiative on Optimism. Only pay an active checkout invoice.</p></details>
            <details><summary>When is my donation complete?<span>+</span></summary><p>Received by the initiative means we verified its USDC transfer on the destination network. Final confirmation continues in the background; the receipt is not yet irreversible. Donation delivered means finality is confirmed. A CHOG deposit alone is not delivery. Keep the invoice to follow its status.</p></details>
            <details><summary>Who processes the funds?<span>+</span></summary><p>ChogCare controls each dedicated deposit address during processing. Nad.fun and Uniswap handle the exchanges; Relay handles the bridge. A failed or late transfer may require manual recovery. Save your invoice ID and never send a second payment to fix a pending one.</p></details>
          </div>
        </section>

      </main>

      <footer className="lp-footer"><div className="lp-footer-top"><Brand footer onHome={() => leaveStation("top")} /><p>An independent community project.<br />Built for Chogathon 2026.</p><a href="https://giveth.io/" target="_blank" rel="noreferrer">Explore Giveth <ArrowUpRight size={16} /></a></div><div className="lp-footer-bottom"><span>© 2026 ChogCare · Created by GX</span><button onClick={copyToken} aria-label="Copy CHOG token address">CHOG <span>{shortAddress(token)}</span>{copied ? <Check size={16} /> : <Copy size={16} />}<span aria-live="polite">{copied ? "Copied" : ""}</span></button><a href="#top" onClick={event => { event.preventDefault(); leaveStation("top"); }}>Back to top ↑</a></div>{copyError && <p className="copy-error">Copy manually: {token}</p>}</footer>
    </div>

    <dialog ref={dialogRef} className="lp-project-dialog" onCancel={() => setOpenInitiative(null)} onClose={() => setOpenInitiative(null)} onClick={event => { if (event.target === event.currentTarget) setOpenInitiative(null); }} aria-labelledby="project-dialog-title">
      {openInitiative && <article>
        <button className="lp-dialog-close" onClick={() => setOpenInitiative(null)} aria-label="Close project details" autoFocus><X size={22} /></button>
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
  </>;
}
