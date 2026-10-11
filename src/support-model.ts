import { validInvoiceId } from "./checkout-session.ts";

export type SupportContext = {
  mode?: "chog" | "nft";
  invoiceId?: string;
  issue?: "payment-unavailable" | "checkout-error" | "invoice-review" | "recovery";
};
export type SupportDraft = { subject: string; message: string; contact: string; includeInvoice: boolean };
export type SupportRequest = { requestId: string; subject: string; message: string; contact?: string; invoiceId?: string };
export type SupportTicket = { reference: string; createdAt: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function supportDraft(context: SupportContext): SupportDraft {
  const message = context.issue === "payment-unavailable"
    ? "I cannot access the donation checkout. Please help me check whether donations are available."
    : context.issue === "invoice-review"
      ? "My donation needs review. Please help me understand its current status. I will not send another payment."
      : context.issue === "recovery"
        ? "I need help recovering my donation checkout. Please help me check its status."
        : "I need help with my donation checkout. I will not send another payment while this issue is unresolved.";
  return { subject: context.mode === "nft" ? "NFT donation support" : "CHOG donation support", message, contact: "", includeInvoice: false };
}
function boundedText(value: unknown, limit: number, label: string, multiline = false): string {
  if (typeof value !== "string" || value.length > limit) throw new Error(`${label} is too long or contains unsupported characters.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > limit || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(normalized) || /[\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(normalized)) throw new Error(`${label} is too long or contains unsupported characters.`);
  return normalized;
}
export function createSupportRequest(draft: SupportDraft, context: SupportContext, previous?: SupportRequest | null, randomUuid = () => crypto.randomUUID()): SupportRequest {
  const subject = boundedText(draft.subject, 80, "Subject"), message = boundedText(draft.message, 1600, "Message", true), contact = boundedText(draft.contact, 160, "Contact");
  if (!subject || !message) throw new Error("Add a subject and message so we can help.");
  if (typeof draft.includeInvoice !== "boolean") throw new Error("Choose whether to include your private invoice reference.");
  const body = { subject, message, ...(contact ? { contact } : {}), ...(draft.includeInvoice && validInvoiceId(context.invoiceId) ? { invoiceId: context.invoiceId } : {}) };
  if (draft.includeInvoice && !validInvoiceId(context.invoiceId)) throw new Error("The private invoice reference could not be verified. Leave it out and describe the issue.");
  if (previous) {
    const { requestId, ...oldBody } = previous;
    if (typeof requestId === "string" && requestId.length === 36 && uuid.test(requestId) && JSON.stringify(oldBody) === JSON.stringify(body)) return previous;
  }
  const requestId = randomUuid();
  if (typeof requestId !== "string" || requestId.length !== 36 || !uuid.test(requestId)) throw new Error("A secure support request could not be prepared.");
  return { requestId, ...body };
}
export function parseSupportTicket(value: unknown): SupportTicket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ticket = (value as { ticket?: unknown }).ticket;
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return null;
  const item = ticket as Record<string, unknown>;
  if (typeof item.reference !== "string" || item.reference.length !== 12 || !/^[A-F0-9]{12}$/.test(item.reference) || !Number.isSafeInteger(item.createdAt) || (item.createdAt as number) <= 0) return null;
  return { reference: item.reference, createdAt: item.createdAt as number };
}
export class SupportSendError extends Error {
  readonly requestMayBeReceived: boolean;
  constructor(message: string, requestMayBeReceived = true) { super(message); this.name = "SupportSendError"; this.requestMayBeReceived = requestMayBeReceived; }
}
export async function sendSupportRequest(request: SupportRequest, signal: AbortSignal, http: typeof fetch = fetch): Promise<SupportTicket> {
  // Bootstrap the signed browser session. No auth secret or invoice capability
  // is placed in a URL, storage, analytics or an outbound third-party request.
  let bootstrap: Response;
  try { bootstrap = await http("/api/payments/config", { signal, credentials: "same-origin", cache: "no-store" }); }
  catch { throw new SupportSendError("Support is temporarily unavailable. Keep your message and try again.", false); }
  if (!bootstrap.ok) throw new SupportSendError("Support is temporarily unavailable. Keep your message and try again.", false);
  let response: Response;
  try {
    response = await http("/api/payments/support", { method: "POST", signal, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } catch {
    throw new SupportSendError("No confirmation yet. Retry this same request; do not send another payment.");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const rejected = [400, 401, 403, 413, 415, 429].includes(response.status);
    throw new SupportSendError(response.status === 429 ? "Too many support requests. Wait a moment and retry your saved message." : "Support could not confirm this request. Keep your message and retry.", !rejected);
  }
  const ticket = parseSupportTicket(data);
  if (!ticket) throw new SupportSendError("The confirmation could not be verified. Retry this same request.");
  return ticket;
}
