import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowRight, ArrowSquareOut, Broadcast, Check, CheckCircle, ChatCircleDots, Coins, EnvelopeSimple, GearSix, GlobeHemisphereWest, Heart, House, Info, Link, LockKey, MonitorPlay, Play, PlugsConnected, ShieldCheck, SquaresFour, Stop, WarningCircle, X } from "@phosphor-icons/react";
import coin from "../../public/chog-donation-coin.png";
import sunset from "../../public/chogcare-sunset.png";
import type { Estimate, Service, ServiceId, Settings, Snapshot, Ticket } from "./contracts";

type Page = "overview" | "services" | "fees" | "support" | "activity" | "settings";
type Confirmation = { type: "payments.start" | "payments.stop" | "station.stop" | "broadcast.stop" | "broadcast.configure" | "services.start"; title: string; description: string; password?: boolean };
const tabs = [{ id: "overview", name: "Overview", Icon: House }, { id: "services", name: "Services", Icon: SquaresFour }, { id: "fees", name: "Bridge fees", Icon: Link }, { id: "support", name: "Support", Icon: ChatCircleDots }, { id: "activity", name: "Activity", Icon: WarningCircle }, { id: "settings", name: "Settings", Icon: GearSix }] as const;
const serviceMeta = { payments: { name: "Payments", Icon: Coins, description: "Accept and process donations safely." }, broadcast: { name: "Broadcast", Icon: Broadcast, description: "Your local Owncast livestream server." }, station: { name: "Care station", Icon: Heart, description: "Connect the screen and LED over USB." }, gateway: { name: "Local gateway", Icon: GlobeHemisphereWest, description: "The local gateway for your existing public route." } };
const causes = [{ id: "school-supplies", name: "School Supplies & Crypto Education" }, { id: "solar-foundation", name: "The Solar Foundation" }, { id: "vida-verde", name: "+Vida +Verde Venezuela" }, { id: "animal-ethics", name: "Animal Ethics" }];
const unknownServices: Service[] = (["payments", "broadcast", "station", "gateway"] as ServiceId[]).map(id => ({ id, state: "unknown", managed: false, detail: "Waiting for the local app." }));
const date = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const money = (value?: string) => value === undefined ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

export default function AdminApp() {
  const api = window.chogcareAdmin;
  const [page, setPage] = useState<Page>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [password, setPassword] = useState("");
  const [port, setPort] = useState("");
  const [amount, setAmount] = useState("300");
  const [cause, setCause] = useState("school-supplies");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [now, setNow] = useState(Date.now());
  const [quoteError, setQuoteError] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketFilter, setTicketFilter] = useState("all");
  const [selected, setSelected] = useState<Ticket | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refreshing = useRef(false);
  const mounted = useRef(true);
  const services = snapshot?.services ?? unknownServices;
  const paymentService = services.find(s => s.id === "payments");
  const paymentsReady = snapshot?.payments?.paymentsEnabled === true;
  const controllerAvailable = Boolean(api);
  const validPort = /^COM[1-9]\d{0,2}$/.test(port);
  const passwordMinimum = confirmation?.type === "broadcast.configure" ? 1 : 16;

  const refresh = useCallback(async () => {
    if (!api || refreshing.current) return;
    refreshing.current = true;
    try { await api.action({ type: "refresh" }); const next = await api.snapshot(); if (mounted.current) setSnapshot(next); }
    catch { if (mounted.current) setNotice("Could not refresh local services. Check Activity and try again."); }
    finally { refreshing.current = false; }
  }, [api]);
  useEffect(() => { mounted.current = true; void refresh(); void api?.settings().then(next => { setSettings(next); setPort(next.stationPort || ""); }).catch(() => setNotice("Local settings are unavailable.")); const timer = setInterval(() => void refresh(), 7000); return () => { mounted.current = false; clearInterval(timer); }; }, [api, refresh]);
  useEffect(() => { const dialog = dialogRef.current; if (confirmation && dialog && !dialog.open) dialog.showModal(); if (!confirmation && dialog?.open) dialog.close(); }, [confirmation]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const loadTickets = useCallback(async () => {
    if (!api) return;
    try { const next = await api.listSupport({ ...(ticketFilter !== "all" ? { status: ticketFilter } : {}), limit: 100 }); setTickets(next); }
    catch { setNotice("Support inbox could not be loaded. Check the local storage status."); }
  }, [api, ticketFilter]);
  useEffect(() => { if (page !== "support") return; void loadTickets(); const timer = setInterval(() => void loadTickets(), 10000); return () => clearInterval(timer); }, [page, loadTickets]);

  async function act(input: Record<string, unknown>, key: string) {
    if (!api || busy) return;
    setBusy(key); setNotice("");
    try { await api.action(input); await refresh(); }
    catch { setNotice("The action could not be completed. Open Activity for the reason. Existing payments have not been reset."); }
    finally { setBusy(""); }
  }
  function ask(next: Confirmation) { setPassword(""); setConfirmation(next); }
  function dismiss() { if (busy) return; setPassword(""); setConfirmation(null); }
  async function confirmAction() {
    if (!api || !confirmation || busy) return;
    if (confirmation.password && (password.length < passwordMinimum || password.length > 256)) { setNotice(`Enter a password between ${passwordMinimum} and 256 characters.`); return; }
    const action = confirmation.type;
    let credential = password; setPassword(""); setBusy(action); setNotice("");
    try {
      if (action === "services.start") {
        const failed: string[] = [];
        const isRunning = (id: ServiceId) => services.some(item => item.id === id && ["running", "external"].includes(item.state));
        const start = async (label: string, input: Record<string, unknown>) => { try { await api.action(input); } catch { failed.push(label); } };
        if (!isRunning("broadcast")) await start("broadcast", { type: "broadcast.start", confirmed: true });
        if (!isRunning("gateway")) await start("gateway", { type: "gateway.start", confirmed: true });
        if (port && !isRunning("station")) await start("care station", { type: "station.start", port });
        if (!isRunning("payments")) await start("payments", { type: "payments.start", password: credential });
        if (failed.length) { setConfirmation(null); await refresh(); setNotice(`Some services did not start: ${failed.join(", ")}. Check Activity. Other running services were left untouched.`); return; }
      } else await api.action({ type: action, ...(action === "broadcast.stop" ? { confirmed: true } : {}), ...(confirmation.password ? { password: credential } : {}) });
      setConfirmation(null); await refresh();
      const next = await api.settings(); setSettings(next);
    } catch { setNotice("The action did not finish. Check Activity before trying again. No existing invoice was reset."); }
    finally { credential = ""; setBusy(""); }
  }
  async function getEstimate() {
    if (!api || busy) return;
    setBusy("quote"); setQuoteError(""); setEstimate(null);
    try { setEstimate(await api.quote({ amount, initiativeId: cause })); setNow(Date.now()); }
    catch { setQuoteError("A verified quote is unavailable right now. No invoice was created and no funds were sent."); }
    finally { setBusy(""); }
  }
  async function ticketStatus(ticket: Ticket, status: string) {
    if (!api || busy) return;
    setBusy("ticket");
    try { await api.updateSupport({ id: ticket.id, status }); setSelected({ ...ticket, status: status as Ticket["status"] }); await loadTickets(); await refresh(); }
    catch { setNotice("The support status could not be saved. Try again without deleting the ticket."); }
    finally { setBusy(""); }
  }
  const quoteExpired = Boolean(estimate && now >= estimate.expiresAt);
  const quotePanel = <section className="admin-panel admin-fee-panel">
    <div className="admin-section-heading"><span className="admin-icon-island"><Link size={26} weight="light" /></span><div><h2>Bridge estimate</h2><p>See the cost before a donation.</p></div></div>
    <div className="admin-quote-inputs"><label>Donation amount<select value={amount} onChange={e => { setAmount(e.target.value); setEstimate(null); }}><option value="300">300 CHOG</option><option value="3000">3,000 CHOG</option><option value="30000">30,000 CHOG</option></select></label><label>Charity<select value={cause} onChange={e => { setCause(e.target.value); setEstimate(null); }}>{causes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <div className="admin-estimate-top"><div><span>Estimated to charity</span><strong>{money(quoteExpired ? undefined : estimate?.expectedCharityUsd)}</strong></div><div><span>Bridge cost</span><strong>{money(quoteExpired ? undefined : estimate?.bridgeFeeUsd)}{estimate && !quoteExpired && <small> {estimate.bridgeFeePercent}%</small>}</strong></div></div>
    {quoteExpired && <p className="admin-error" role="status">This estimate expired. Get a fresh estimate before relying on its amounts.</p>}
    {estimate && <div className="admin-quote-details"><p><span>Total sent (incl. pool)</span><b>{Number(estimate.totalChog).toLocaleString("en-US")} CHOG</b></p><p><span>NFT community pool</span><b>{Number(estimate.poolContributionChog).toLocaleString("en-US")} CHOG</b></p><p><span>Conversion minimum (incl. pool)</span><b>{money(estimate.conversionMinimumUsdc)}</b></p><p><span>Minimum to charity</span><b>{money(estimate.minimumCharityUsd)}</b></p><p><span>Quote checked</span><b>{date(estimate.checkedAt)}</b></p><p className="admin-small">{estimate.notice} Quotes change; this does not create a payment.</p></div>}
    {quoteError && <p className="admin-error" role="alert">{quoteError}</p>}
    <button className="admin-button admin-primary" disabled={!api || Boolean(busy)} onClick={() => void getEstimate()}><Link size={20} weight="light" />{busy === "quote" ? "Checking the route…" : "Get estimate"}<span className="admin-button-arrow"><ArrowRight size={18} /></span></button>
    {!estimate && !quoteError && <p className="admin-small">A read-only, signed route estimate. No money moves.</p>}
  </section>;

  return <div className="admin-shell">
    <aside className="admin-sidebar"><div className="admin-brand"><img src={coin} alt="CHOG" /><strong>Chog<span>Care</span></strong><small>Admin</small></div><nav aria-label="Admin navigation">{tabs.map(({ id, name, Icon }) => <button key={id} className={page === id ? "is-active" : ""} onClick={() => { setPage(id); setSelected(null); }} aria-current={page === id ? "page" : undefined}><Icon size={23} weight="light" />{name}{id === "support" && (snapshot?.support.open ?? 0) > 0 && <span className="admin-count">{snapshot?.support.open}</span>}</button>)}</nav><div className="admin-sidebar-footer"><Heart size={22} weight="light" /><p>Good people.<br />Brighter tomorrows.</p><small><LockKey size={13} /> Local access only</small></div></aside>
    <main className="admin-main">
      <header className={`admin-header ${page === "overview" ? "admin-hero" : ""}`}>
        {page === "overview" && <img className="admin-hero-art" src={sunset} alt="CHOG supporting causes at the ChogCare terminal" />}
        <div className="admin-heading"><span className="admin-eyebrow">CHOGCARE ADMIN</span><h1>{page === "overview" ? <>A little care.<br /><span>A big difference.</span></> : tabs.find(t => t.id === page)?.name}</h1><p>{page === "overview" ? "Your care station, in one place." : page === "services" ? "Start what you need. Know what is running." : page === "fees" ? "CHOG → Charity. A transparent estimate." : page === "support" ? "Real people. Give them a little care." : page === "activity" ? "Clear updates. No terminal required." : "Your local setup, without the command line."}</p></div>
        <button className="admin-site-link" disabled={!api} onClick={() => void api?.open("website")}><ArrowSquareOut size={18} />View site</button>
      </header>
      {!controllerAvailable && <div className="admin-notice"><Info size={22} /><p>Design preview only. Open the Windows app to connect local services. This browser page has no admin access.</p></div>}
      {controllerAvailable && paymentService?.state === "external" && <div className="admin-notice"><Info size={22} /><p>Payments are running outside this app. To manage them here, press Ctrl+C once in the original payment terminal, wait for its safe shutdown, then choose Start services and enter your vault password here. Existing invoices are preserved; never force-close that process.</p></div>}
      {notice && <div className="admin-notice" role="alert"><WarningCircle size={22} /><p>{notice}</p><button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={18} /></button></div>}

      {page === "overview" && <>
        <section className="admin-readiness"><div><p><span className={`admin-dot ${paymentsReady ? "is-ready" : ""}`} />{paymentsReady ? "Donations are enabled" : snapshot?.payments?.integrityLocked ? "Safety check required" : "Local service overview"}</p><h2>{paymentsReady ? "Care is moving." : "Ready when you are."}</h2><p>{paymentsReady ? "Keep the app running while you welcome donations." : "Start your services here. We will check each step."}</p></div><div className="admin-readiness-actions"><button className="admin-button admin-primary" disabled={!api || Boolean(busy)} onClick={() => ask({ type: "services.start", title: "Start your care station", description: "Starts Owncast, the existing local gateway and the configured USB bridge. Payments unlock only with your custody password. OBS stays under your control. Running services are not duplicated.", password: paymentService?.state !== "external" && paymentService?.state !== "running" })}><Play size={20} weight="fill" />Start services</button><button className="admin-button admin-outline" disabled={!api || Boolean(busy)} onClick={() => void act({ type: "refresh" }, "refresh")}><ArrowClockwise size={20} />Check status</button></div></section>
        <div className="admin-service-grid">{services.map(service => { const meta = serviceMeta[service.id]; return <button className="admin-service-tile" key={service.id} onClick={() => setPage("services")}><span className={`admin-icon-island admin-${service.id}`}><meta.Icon size={27} weight="light" /></span><div><h3>{meta.name}</h3><p><span className={`admin-dot ${["running", "external"].includes(service.state) ? "is-ready" : service.state === "error" ? "is-error" : ""}`} />{service.state === "external" ? "Running externally" : service.state === "unknown" ? snapshot ? "Not confirmed" : "Checking" : service.state[0].toUpperCase() + service.state.slice(1)}</p></div><ArrowRight size={18} /></button>; })}</div>
        <div className="admin-overview-bottom">{quotePanel}<section className="admin-panel admin-inbox-overview"><div className="admin-section-heading"><span className="admin-icon-island"><ChatCircleDots size={26} weight="light" /></span><div><h2>Support inbox</h2><p>You are here when they need you.</p></div></div><div className="admin-inbox-empty"><EnvelopeSimple size={48} weight="light" /><h3>{snapshot ? snapshot.support.open ? `${snapshot.support.open} open ${snapshot.support.open === 1 ? "message" : "messages"}` : "No new messages" : "Checking your inbox"}</h3><p>{snapshot?.support.open ? "A little help can make a big difference." : "User reports arrive here and stay on this computer."}</p></div><button className="admin-button admin-outline" onClick={() => setPage("support")}>View inbox<span className="admin-button-arrow"><ArrowRight size={18} /></span></button></section></div>
      </>}

      {page === "services" && <div className="admin-service-list">{services.map(service => { const meta = serviceMeta[service.id]; const running = ["running", "external"].includes(service.state); return <section className="admin-panel" key={service.id}><div className="admin-section-heading"><span className={`admin-icon-island admin-${service.id}`}><meta.Icon size={27} weight="light" /></span><div><h2>{meta.name}</h2><p>{meta.description}</p></div><span className={`admin-state ${running ? "is-ready" : ""}`}>{service.state === "external" ? "Running externally" : service.state}</span></div><p className="admin-service-detail">{service.detail}</p><div className="admin-service-actions">
        {service.id === "payments" && <><button className="admin-button admin-primary" disabled={!api || running || Boolean(busy)} onClick={() => ask({ type: "payments.start", title: "Unlock payments", description: "Enter the password for your existing custody vault. It is passed once to the local worker and never saved in settings or logs.", password: true })}><LockKey size={19} />Unlock & start</button><button className="admin-button admin-outline" disabled={!api || !service.managed || !running || Boolean(busy)} onClick={() => ask({ type: "payments.stop", title: "Pause app-managed payments?", description: "New QR codes will pause. The worker finishes its safe shutdown and preserves invoices and its integrity checkpoint. Do not ask donors to pay again." })}><Stop size={18} />Stop safely</button></>}
        {service.id === "station" && <><label className="admin-inline-field">USB port<input value={port} onChange={e => setPort(e.target.value.toUpperCase())} placeholder="COM3" maxLength={8} aria-label="Care station serial port" /></label><button className="admin-button admin-primary" disabled={!api || running || !validPort || Boolean(busy)} onClick={() => void act({ type: "station.start", port }, "station.start")}><PlugsConnected size={18} />Connect station</button><button className="admin-button admin-outline" disabled={!api || !service.managed || !running || Boolean(busy)} onClick={() => ask({ type: "station.stop", title: "Disconnect the USB bridge?", description: "Stops only the bridge started by this app. Donations continue processing; no fake station event is sent." })}>Disconnect</button><button className="admin-button admin-outline admin-test-button" aria-describedby="station-test-note" aria-busy={busy === "station.test" || snapshot?.stationTest === "running"} disabled={!api || !service.managed || !running || Boolean(busy) || snapshot?.stationTest === "running"} onClick={() => void act({ type: "station.test" }, "station.test")}><MonitorPlay size={19} />{busy === "station.test" || snapshot?.stationTest === "running" ? "Testing screen…" : "Test screen"}</button></>}
        {service.id === "broadcast" && <><button className="admin-button admin-primary" disabled={!api || running || Boolean(busy)} onClick={() => void act({ type: "broadcast.start", confirmed: true }, "broadcast.start")}><Play size={18} />Start Owncast</button><button className="admin-button admin-outline" disabled={!api || !running || Boolean(busy)} onClick={() => ask({ type: "broadcast.stop", title: "Stop the livestream server?", description: "The livestream will disconnect. OBS and payment processing are not stopped. Restart Owncast here when you are ready." })}><Stop size={18} />Stop Owncast</button><button className="admin-button admin-outline" disabled={!api || Boolean(busy)} onClick={() => void act({ type: "obs.open" }, "obs.open")}><MonitorPlay size={18} />Open OBS</button></>}
        {service.id === "gateway" && <button className="admin-button admin-primary" disabled={!api || Boolean(busy)} onClick={() => void act({ type: "gateway.start", confirmed: true }, "gateway.start")}><GlobeHemisphereWest size={18} />Start local gateway</button>}
      </div>{service.id === "station" && <p id="station-test-note" className="admin-station-test-note" role="status" aria-live="polite">{snapshot?.stationTest === "running" ? "Test queued. Waiting for the device to confirm the animation finished." : snapshot?.stationTest === "done" ? "Screen test completed — confirmed by the device. No funds moved." : snapshot?.stationTest === "error" ? "Screen test was not confirmed. Check Activity and the USB connection." : "Shows a simulated 300 CHOG arrival labelled TEST - NO PAYMENT. No transaction, history or leaderboard entry. Real donation notifications are not interrupted."}</p>}{service.state === "external" && ["payments", "station"].includes(service.id) && <p className="admin-small"><ShieldCheck size={16} />Started outside this app. We will not stop it or start a duplicate.</p>}</section>; })}<div className="admin-notice"><Info size={22} /><p>Owncast receives your stream; you still start the camera in OBS. The gateway keeps its existing protected public route — the app never exposes an admin page.</p></div></div>}

      {page === "fees" && <div className="admin-fees-page">{quotePanel}<section className="admin-panel admin-fee-explainer"><img src={coin} alt="CHOG" /><h2>CHOG → Charity</h2><p>The donation amount goes toward the selected charity. A separate 10% is added on top for the NFT community pool.</p><p>Bridge estimates are checked against signed route terms. Gas, price movement and slippage are not a fixed bridge fee. No estimate creates a QR code or sends money.</p><div className="admin-policy-line"><Heart size={22} /><span>NFT benefit</span><b>{snapshot?.payments?.subsidyUsdc ? `$${snapshot.payments.subsidyUsdc}` : "$1.00"} / day</b></div><div className="admin-policy-line"><Coins size={22} /><span>Daily pool</span><b>{snapshot?.payments?.dailyPoolLimitUsdc ? `$${snapshot.payments.dailyPoolLimitUsdc}` : "$3.00"}</b></div><p className="admin-small">One claim per NFT and wallet per UTC day. Transferring an NFT does not reset its daily use.</p></section></div>}

      {page === "support" && <div className="admin-support-page"><section className="admin-panel admin-tickets"><div className="admin-section-heading"><h2>Messages <small>{tickets.length}</small></h2><button className="admin-icon-button" onClick={() => void loadTickets()} disabled={!api || Boolean(busy)} aria-label="Refresh inbox"><ArrowClockwise size={20} /></button></div><div className="admin-filter" role="group" aria-label="Filter support messages">{["all", "new", "read", "resolved"].map(filter => <button key={filter} className={ticketFilter === filter ? "is-active" : ""} onClick={() => setTicketFilter(filter)}>{filter[0].toUpperCase() + filter.slice(1)}</button>)}</div>{tickets.length ? <div className="admin-ticket-list">{tickets.map(ticket => <button key={ticket.id} className={selected?.id === ticket.id ? "is-selected" : ""} onClick={() => { setSelected(ticket); if (ticket.status === "new") void ticketStatus(ticket, "read"); }}><span className={`admin-ticket-status ${ticket.status}`} /><div><strong>{ticket.subject}</strong><p>{ticket.message.slice(0, 90)}</p><small>{date(ticket.createdAt)} · {ticket.reference}</small></div><ArrowRight size={17} /></button>)}</div> : <div className="admin-inbox-empty"><EnvelopeSimple size={48} weight="light" /><h3>No messages here yet</h3><p>Contact support reports from the website appear here. No ticket is publicly listed.</p></div>}</section><section className="admin-panel admin-ticket-detail">{selected ? <><div className="admin-ticket-meta"><span>{selected.reference}</span><span>{selected.status}</span></div><h2>{selected.subject}</h2><p className="admin-ticket-message">{selected.message}</p><dl><div><dt>Received</dt><dd>{date(selected.createdAt)}</dd></div><div><dt>Reply contact</dt><dd>{selected.contact || "Not provided"}</dd></div>{selected.invoiceId && <div><dt>Shared invoice reference</dt><dd className="admin-reference">{selected.invoiceId}</dd></div>}</dl><p className="admin-small">Reply using the contact they provided. This version does not send automatic replies or emails.</p><button className="admin-button admin-primary" disabled={Boolean(busy)} onClick={() => void ticketStatus(selected, selected.status === "resolved" ? "read" : "resolved")}><Check size={20} />{selected.status === "resolved" ? "Reopen message" : "Mark resolved"}</button></> : <div className="admin-inbox-empty"><ChatCircleDots size={52} weight="light" /><h3>A little attention goes a long way.</h3><p>Select a message to see its details.</p></div>}</section></div>}

      {page === "activity" && <section className="admin-panel"><div className="admin-section-heading"><h2>Recent activity</h2><button className="admin-button admin-outline" disabled={!api || Boolean(busy)} onClick={() => void act({ type: "refresh" }, "refresh")}><ArrowClockwise size={18} />Refresh</button></div><p className="admin-small">Sanitized local events. Passwords, keys and raw signed transactions are never shown.</p><div className="admin-activity-list">{snapshot?.events.length ? [...snapshot.events].reverse().map(event => <article key={event.id} className={event.level}><span className="admin-icon-island">{event.level === "error" ? <WarningCircle size={20} /> : event.level === "warning" ? <Info size={20} /> : <CheckCircle size={20} />}</span><div><strong>{event.message}</strong><p>{event.service} · {date(event.at)}</p></div></article>) : <div className="admin-inbox-empty"><ShieldCheck size={44} weight="light" /><h3>No recent events</h3><p>Service actions and errors will appear here.</p></div>}</div></section>}

      {page === "settings" && <div className="admin-settings-page"><section className="admin-panel"><div className="admin-section-heading"><span className="admin-icon-island"><PlugsConnected size={25} /></span><div><h2>Care station</h2><p>Use the USB port assigned to the NodeMCU.</p></div></div><label className="admin-field">Serial port<input value={port} placeholder="COM3" maxLength={8} onChange={e => setPort(e.target.value.toUpperCase())} /></label><button className="admin-button admin-primary" disabled={!api || !validPort || Boolean(busy)} onClick={() => void act({ type: "settings.save", stationPort: port }, "settings.save")}><Check size={19} />Save port</button><p className="admin-small">Screen and LED wiring stay unchanged. Saving the port does not flash firmware.</p></section><section className="admin-panel"><div className="admin-section-heading"><span className="admin-icon-island"><Broadcast size={25} /></span><div><h2>Broadcast quality</h2><p>A verified Owncast quality profile.</p></div></div><div className="admin-profile-values"><span>1080 px wide</span><span>30 fps</span><span>4,500 kbps</span><span>Low latency</span></div><button className="admin-button admin-primary" disabled={!api || Boolean(busy)} onClick={() => ask({ type: "broadcast.configure", title: "Apply the broadcast profile", description: "Enter your current Owncast admin password. Only video settings change; the OBS stream key stays untouched. The new settings apply after you stop and start your stream in OBS.", password: true })}><LockKey size={18} />Enter password & apply</button><p className="admin-small">{settings?.owncastPasswordSet ? "Admin password verified during this session." : "Passwords are not saved. Enter the Owncast password when applying settings."}</p></section><section className="admin-panel admin-settings-wide"><div className="admin-section-heading"><span className="admin-icon-island"><ShieldCheck size={25} /></span><div><h2>Local by design</h2><p>Admin controls live on this computer, not on the public site.</p></div></div><dl><div><dt>Project folder</dt><dd>{settings?.workspacePath ?? snapshot?.workspacePath ?? "Waiting for the Windows app"}</dd></div><div><dt>Passwords</dt><dd>Entered locally, passed in memory, never stored in plaintext.</dd></div><div><dt>Closing the window</dt><dd>Minimizes to the tray; managed services keep running. Use the tray menu to quit safely.</dd></div></dl><button className="admin-button admin-outline" disabled={!api} onClick={() => void api?.open("dashboard")}><ArrowSquareOut size={18} />Open the read-only phone dashboard</button></section></div>}
      <footer className="admin-footer"><span><LockKey size={14} />Local controls. Real care.</span><span>{snapshot?.checkedAt ? `Checked ${date(snapshot.checkedAt)}` : "Waiting for local services"}<Heart size={16} /></span></footer>
    </main>
    <dialog className="admin-dialog" ref={dialogRef} onCancel={event => { event.preventDefault(); dismiss(); }}><div className="admin-dialog-head"><img src={coin} alt="CHOG" /><button className="admin-icon-button" aria-label="Close dialog" disabled={Boolean(busy)} onClick={dismiss}><X size={22} /></button></div><h2>{confirmation?.title}</h2><p>{confirmation?.description}</p><form onSubmit={event => { event.preventDefault(); void confirmAction(); }}>{confirmation?.password && <label className="admin-field">{confirmation.type === "broadcast.configure" ? "Owncast admin password" : "Custody vault password"}<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} maxLength={256} minLength={passwordMinimum} autoFocus required disabled={Boolean(busy)} /><span className="admin-small"><LockKey size={14} />Never shared with the website or mobile dashboard.</span></label>}<div className="admin-dialog-actions"><button type="button" className="admin-button admin-outline" disabled={Boolean(busy)} onClick={dismiss}>Cancel</button><button className="admin-button admin-primary" type="submit" disabled={!api || Boolean(busy) || Boolean(confirmation?.password && password.length < passwordMinimum)}>{busy ? "Working safely…" : "Continue"}<span className="admin-button-arrow"><ArrowRight size={17} /></span></button></div></form></dialog>
  </div>;
}
