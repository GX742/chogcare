import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowsLeftRight, Broadcast, CaretDown, Coins, CreditCard, Heart, Users } from "@phosphor-icons/react";
import { publicBroadcastOrigin } from "./broadcast-source";
import { checkoutSelection } from "./checkout-session";
import { initiativeNames } from "./donation-share";
import { bridgeAmounts, dashboardChogAmount, formatEstimateUsd, observeBroadcast, parseDashboardSnapshot, readBroadcastManifest, type BridgeAmount, type BridgeEstimate, type BroadcastObservation, type DashboardSnapshot, type ServiceState } from "./ops-dashboard-model";
import { readBoundedBroadcastBody, runBridgeEstimate } from "./ops-dashboard-requests";
import "./ops-dashboard.css";

type DisplayStatus = { label: string; tone: "ready" | "paused" | "offline" | "unknown" };
const paymentStatus = (state: ServiceState | undefined, checking: boolean): DisplayStatus => state ? { label: state === "ready" ? "Ready" : state === "paused" ? "Paused" : "Offline", tone: state } : { label: checking ? "Checking" : "Unavailable", tone: "unknown" };
const streamUrl = `${publicBroadcastOrigin}/hls/stream.m3u8`;

async function playlist(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok) throw new Error("Broadcast unavailable.");
  const body = await readBoundedBroadcastBody(response);
  const manifest = readBroadcastManifest(body, url);
  if (!manifest) throw new Error("Broadcast status unavailable.");
  return manifest;
}

export default function OpsDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [broadcast, setBroadcast] = useState<DisplayStatus>({ label: "Checking", tone: "unknown" });
  const observation = useRef<BroadcastObservation | null>(null);
  const [amount, setAmount] = useState<BridgeAmount>("300");
  const [estimate, setEstimate] = useState<BridgeEstimate | null>(null);
  const [estimateError, setEstimateError] = useState("");
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const estimateAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [initiativeId] = useState(() => {
    try { const cause = checkoutSelection("school-supplies").initiativeId; return Object.hasOwn(initiativeNames, cause) ? cause : "school-supplies"; }
    catch { return "school-supplies"; }
  });

  useEffect(() => {
    mounted.current = true;
    document.title = "ChogCare · Dashboard";
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, running = false;
    const controller = new AbortController();
    const loadDashboard = async (signal: AbortSignal) => {
      try {
        const response = await fetch("/api/payments/dashboard", { signal, cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error();
        const next = parseDashboardSnapshot(await response.json());
        const time = Date.now();
        if (!next || next.checkedAt > time + 30_000 || time - next.checkedAt > 45_000) throw new Error();
        if (!disposed) setSnapshot(next);
      } catch { if (!disposed) setSnapshot(null); }
      finally { if (!disposed) setChecking(false); }
    };
    const loadBroadcast = async (signal: AbortSignal) => {
      try {
        const master = await playlist(streamUrl, signal);
        const media = master.variant ? await playlist(master.variant, signal) : master;
        const next = observeBroadcast(observation.current, media);
        if (!disposed) { observation.current = next.observation; setBroadcast({ label: next.live ? "Live" : "Not confirmed", tone: next.live ? "ready" : "unknown" }); }
      } catch { if (!disposed) { observation.current = null; setBroadcast({ label: "Unavailable", tone: "unknown" }); } }
    };
    const poll = async () => {
      if (disposed || running || document.hidden) return;
      running = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        await Promise.all([loadDashboard(signal), loadBroadcast(signal)]);
      } finally { running = false; if (!disposed) timer = setTimeout(() => void poll(), 15_000); }
    };
    const visibility = () => {
      if (document.hidden) { setSnapshot(null); setBroadcast({ label: "Not confirmed", tone: "unknown" }); observation.current = null; }
      else { clearTimeout(timer); void poll(); }
    };
    void poll(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; mounted.current = false; controller.abort(); estimateAbort.current?.abort(); estimateAbort.current = null; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (!estimate) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [estimate]);

  const checkEstimate = async () => {
    if (!mounted.current || estimateAbort.current) return;
    const controller = new AbortController(); estimateAbort.current = controller;
    setEstimateBusy(true); setEstimateError(""); setEstimate(null);
    await runBridgeEstimate({
      amount, initiativeId,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      isCurrent: () => mounted.current && estimateAbort.current === controller,
      onResult: next => { setEstimate(next); setNow(Date.now()); },
      onError: setEstimateError,
      onSettled: () => { estimateAbort.current = null; setEstimateBusy(false); },
    });
  };
  const expired = !!estimate && now >= estimate.expiresAt;
  const statuses = [
    { label: "Payments", Icon: CreditCard, status: paymentStatus(snapshot?.payments.state, checking) },
    { label: "Live broadcast", Icon: Broadcast, status: broadcast },
    { label: "NFT pool", Icon: Coins, status: paymentStatus(snapshot?.payments.nftState, checking) },
    { label: "Care station", Icon: Heart, status: { label: "Not confirmed", tone: "unknown" } as DisplayStatus },
  ];

  return <main className="ops-dashboard">
    <div className="ops-shell">
      <header className="ops-hero">
        <img className="ops-hero-art" src="/chogcare-sunset.png" alt="" aria-hidden="true" fetchPriority="high"/>
        <a className="ops-wordmark" href="/" aria-label="ChogCare home"><img src="/chog-donation-coin.png" alt="" width="52" height="52"/><span>Chog<span>Care</span></span></a>
        <div className="ops-hero-copy"><h1>Care,<br/><span>at a glance.</span></h1><p>Live status. Real impact.</p></div>
      </header>
      <section className="ops-status-panel" aria-labelledby="ops-service-title">
        <div className="ops-section-title"><span className="ops-title-icon"><Broadcast size={27} weight="duotone"/></span><h2 id="ops-service-title">Service status</h2></div>
        <ul className="ops-status-list">{statuses.map(({ label, Icon, status }) => <li key={label}><Icon size={25} weight="regular" aria-hidden="true"/><span>{label}</span><span className={`ops-status ops-status-${status.tone}`}><i aria-hidden="true"/>{status.label}</span></li>)}</ul>
        <p className="ops-status-note">{snapshot ? `Checked ${new Date(snapshot.checkedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Station activity is not publicly verified.` : checking ? "Checking the public service, without admin access." : "The public service could not be checked. Unknown is not offline."}</p>
      </section>
      <section className="ops-metrics" aria-label="Donation impact">
        <article className="ops-metric"><span className="ops-metric-icon"><Heart size={23} weight="fill"/></span><h2>CHOG donated</h2><strong title={snapshot?.impact?.chogDonated}>{snapshot?.impact ? dashboardChogAmount(snapshot.impact.chogDonated) : "—"}</strong><p>{snapshot?.impact ? `${snapshot.impact.donations.toLocaleString("en-US")} completed ${snapshot.impact.donations === 1 ? "donation" : "donations"}` : "Verified contributions"}</p></article>
        <article className="ops-metric"><span className="ops-metric-icon"><Users size={23} weight="fill"/></span><h2>Daily NFT places</h2><strong>{snapshot?.payments.availableClaims === null || !snapshot ? "—" : <>{snapshot.payments.availableClaims}<small> / 3</small></>}</strong><p>$1 each · resets at 00:00 UTC</p></article>
      </section>
      <section className="ops-estimate" aria-labelledby="ops-estimate-title">
        <div className="ops-section-title"><ArrowsLeftRight size={27} aria-hidden="true"/><h2 id="ops-estimate-title">Bridge estimate</h2></div>
        <p className="ops-estimate-cause">For {initiativeNames[initiativeId]}</p>
        <div className="ops-estimate-controls"><label className="ops-amount"><img src="/chog-donation-coin.png" alt="" width="38" height="38"/><span className="ops-sr-only">CHOG amount to estimate</span><select value={amount} onChange={event => { setAmount(event.target.value as BridgeAmount); setEstimate(null); setEstimateError(""); }} disabled={estimateBusy}>{bridgeAmounts.map(value => <option key={value} value={value}>{Number(value).toLocaleString("en-US")} CHOG</option>)}</select><CaretDown size={18} aria-hidden="true"/></label><button className="ops-estimate-button" type="button" onClick={() => void checkEstimate()} disabled={estimateBusy}>{estimateBusy ? "Checking…" : "Check estimate"}<ArrowRight size={18}/></button></div>
        <p className="ops-estimate-hint">An estimate, not a payment.</p>
        {estimateError && <p className="ops-estimate-error" role="alert">{estimateError}</p>}
        {estimate && <div className={`ops-quote${expired ? " ops-quote-expired" : ""}`} aria-live="polite">
          <p className="ops-quote-label">{expired ? "Estimate expired · check again" : "Expected to reach the charity"}</p><strong className="ops-quote-amount">{formatEstimateUsd(estimate.expectedCharityUsd)}</strong>
          <dl><div><dt>Quoted minimum</dt><dd>{formatEstimateUsd(estimate.minimumCharityUsd)}</dd></div><div><dt>Delivery fee</dt><dd>{formatEstimateUsd(estimate.bridgeFeeUsd)} <span>({estimate.bridgeFeePercent}%)</span></dd></div><div><dt>Total including the 10% pool contribution</dt><dd>{dashboardChogAmount(estimate.totalChog)} CHOG</dd></div>{estimate.estimatedSeconds !== null && <div><dt>Estimated delivery</dt><dd>About {Math.ceil(estimate.estimatedSeconds / 60)} min</dd></div>}</dl>
          <p className="ops-quote-note">{estimate.notice}</p>
        </div>}
      </section>
      <a className="ops-visit" href="/"><span>Visit ChogCare</span><span className="ops-visit-arrow"><ArrowRight size={24}/></span></a>
      <footer className="ops-footer">Read-only dashboard. No admin access.</footer>
    </div>
  </main>;
}
