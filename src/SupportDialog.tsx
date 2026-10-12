import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChatCircle, Check, Copy, ShieldCheck, X } from "@phosphor-icons/react";
import { validInvoiceId } from "./checkout-session";
import { createSupportRequest, sendSupportRequest, supportDraft, SupportSendError, type SupportContext, type SupportDraft, type SupportRequest, type SupportTicket } from "./support-model";
import "./support-dialog.css";

type Props = { context: SupportContext | null; onClose: () => void };

export default function SupportDialog({ context, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const subject = useRef<HTMLInputElement>(null);
  const contextKey = useRef("");
  const request = useRef<SupportRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [draft, setDraft] = useState<SupportDraft>(() => supportDraft({}));
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!context) { dialog.current?.close(); return; }
    const key = JSON.stringify([context.mode, context.invoiceId, context.issue]);
    if (key !== contextKey.current) {
      contextKey.current = key;
      generation.current++;
      controller.current?.abort();
      request.current = null;
      setDraft(supportDraft(context)); setBusy(false); setUncertain(false); setError(""); setTicket(null); setCopied(false);
    }
    if (dialog.current && !dialog.current.open) { dialog.current.showModal(); subject.current?.focus({ preventScroll: true }); }
  }, [context]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  const update = (field: "subject" | "message" | "contact", value: string) => setDraft(previous => ({ ...previous, [field]: value }));
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!context || busy || ticket) return;
    const currentGeneration = generation.current;
    try {
      request.current = createSupportRequest(draft, context, request.current);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Check your message and try again."); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const next = await sendSupportRequest(request.current, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]));
      if (generation.current === currentGeneration) { setTicket(next); setUncertain(false); }
    } catch (problem) {
      if (generation.current === currentGeneration) {
        const failure = problem instanceof SupportSendError ? problem : new SupportSendError("No confirmation yet. Retry this same request; do not send another payment.");
        setError(failure.message); setUncertain(failure.requestMayBeReceived);
        if (!failure.requestMayBeReceived) request.current = null;
      }
    } finally { if (generation.current === currentGeneration) setBusy(false); }
  };
  const locked = busy || uncertain;

  return <dialog ref={dialog} className="support-dialog" aria-labelledby="support-title" aria-describedby="support-intro" onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="support-tools">
      <button className="support-close" type="button" onClick={onClose} aria-label="Close support"><X size={22}/></button>
    </div>
    <div className="support-content">
      <span className="support-icon" aria-hidden="true"><ChatCircle size={28} weight="duotone"/></span>
      <p className="support-eyebrow">CHOGCARE SUPPORT</p>
      <h2 id="support-title">A little help,<br/><span>when you need it.</span></h2>
      <p id="support-intro" className="support-intro">Tell us what happened. Do not send another payment to fix a checkout issue.</p>
      {ticket ? <section className="support-confirmation" aria-live="polite">
        <span className="support-confirmed"><Check size={22} weight="bold"/> Request received</span>
        <p>Your support reference</p>
        <strong className="support-reference">{ticket.reference}</strong>
        <p>Keep this reference for the ChogCare team. This is a support request, not a new payment.</p>
        <button className="support-secondary" type="button" onClick={() => void navigator.clipboard.writeText(ticket.reference).then(() => setCopied(true)).catch(() => setError("Copy is unavailable. Select your reference above."))}>{copied ? <Check size={18}/> : <Copy size={18}/>} {copied ? "Reference copied" : "Copy reference"}</button>
        {error && <p className="support-error" role="alert">{error}</p>}
        <button className="support-submit" type="button" onClick={onClose}>Back to my donation <ArrowRight size={19}/></button>
      </section> : <form onSubmit={event => void submit(event)} aria-busy={busy}>
        <label htmlFor="support-subject">Subject</label>
        <input ref={subject} id="support-subject" value={draft.subject} onChange={event => update("subject", event.target.value)} maxLength={80} required disabled={locked}/>
        <div className="support-field-heading"><label htmlFor="support-message">What happened?</label><span>{draft.message.length}/1,600</span></div>
        <textarea id="support-message" value={draft.message} onChange={event => update("message", event.target.value)} maxLength={1600} rows={5} required disabled={locked}/>
        <label htmlFor="support-contact">Email or contact handle <span>(optional)</span></label>
        <input id="support-contact" value={draft.contact} onChange={event => update("contact", event.target.value)} maxLength={160} autoComplete="off" placeholder="Where the team can reply" disabled={locked}/>
        {validInvoiceId(context?.invoiceId) && <label className="support-consent"><input type="checkbox" checked={draft.includeInvoice} onChange={event => setDraft(previous => ({ ...previous, includeInvoice: event.target.checked }))} disabled={locked}/><span><strong>Include my private invoice reference</strong><span>Only if you want the team to review this specific donation. It is not included by default.</span></span></label>}
        <p className="support-privacy"><ShieldCheck size={20} aria-hidden="true"/> Never share a password, private key or seed phrase. We do not need them.</p>
        {error && <p className="support-error" role="alert">{error}</p>}
        {uncertain && <p className="support-retry-note">Your message is kept unchanged so a retry cannot create a duplicate request.</p>}
        <button className="support-submit" type="submit" disabled={busy}>{busy ? "Sending your message…" : uncertain ? "Retry this request" : "Send to ChogCare"}<ArrowRight size={19}/></button>
        <p className="support-footnote">Only the message and details you choose are sent.</p>
      </form>}
    </div>
  </dialog>;
}
