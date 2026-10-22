import type { CheckoutMode } from "./checkout.ts";
import { supportsChog, supportsNft } from "./chog-beneficiary.ts";

// IDs are private recovery capabilities. Keep them in this tab, not URLs or
// analytics. Existing v1 keys remain intact; neither payment mode replaces the other.
export const activeInvoiceKeys = { chog: "chogcare:active-invoice:v1", nft: "chogcare:active-nft-invoice:v1" } as const;
const pendingKeys = { chog: "chogcare:pending-chog:v1", nft: "chogcare:pending-nft:v1" } as const;
const preferredKey = "chogcare:checkout-mode:v1";
const historyKey = "chogcare:invoice-history:v1";
const causeKey = (mode: CheckoutMode) => `chogcare:invoice-cause:${mode}:v1`;
export const checkoutChanged = "chogcare:checkout-changed";
export type CreationInput = { mode: CheckoutMode; amount: string; holderAddress: string; initiativeId: string; tokenId?: string };
export type PendingCreation = { key: string; input: CreationInput };
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function validInvoiceId(id: unknown): id is string { return typeof id === "string" && id.length === 64 && /^[a-f0-9]{64}$/.test(id); }
export function assertUnpaidCheckout(id: string, invoice: { id: string; state: string; depositHash?: string | null; bridgeHash?: string | null; destinationHash?: string | null; observedDestinationHash?: string | null }, { allowExpired = false } = {}) {
  if (!validInvoiceId(id) || invoice.id !== id || (invoice.state !== "awaiting-payment" && !(allowExpired && invoice.state === "expired")) || invoice.depositHash || invoice.bridgeHash || invoice.destinationHash || invoice.observedDestinationHash) throw new Error("This payment may be processing. Keep it open; do not pay again.");
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function announce() { if (typeof window !== "undefined") window.dispatchEvent(new Event(checkoutChanged)); }
export function currentStore(): SessionStore {
  try { return window.sessionStorage; } catch { throw new Error("Private payment recovery storage is unavailable. Enable session storage before creating a payment."); }
}
export function savedInvoice(mode: CheckoutMode, storage = currentStore()): string { return storage.getItem(activeInvoiceKeys[mode]) || ""; }
export function initialCheckout(mode: CheckoutMode) {
  try { return { id: savedInvoice(mode), pending: pendingCreation(mode), error: "" }; }
  catch (problem) { return { id: "", pending: null, error: problem instanceof Error ? problem.message : "Payment recovery storage is unavailable." }; }
}
export function pendingCreation(mode: CheckoutMode, storage = currentStore()): PendingCreation | null {
  const raw = storage.getItem(pendingKeys[mode]);
  if (!raw) return null;
  let value: PendingCreation;
  try { value = JSON.parse(raw); } catch { throw new Error("Saved payment request needs recovery. Do not start another payment."); }
  if (!value || typeof value.key !== "string" || value.key.length !== 36 || !uuid.test(value.key) || !value.input || value.input.mode !== mode || !(mode === "chog" ? supportsChog(value.input.initiativeId) : supportsNft(value.input.initiativeId)) ||
    typeof value.input.amount !== "string" || typeof value.input.holderAddress !== "string" ||
    (value.input.tokenId !== undefined && typeof value.input.tokenId !== "string")) throw new Error("Saved payment request is invalid. Contact the operator before paying.");
  return value;
}
export function savedCheckoutModes(storage = currentStore()) {
  return { chog: !!(storage.getItem(activeInvoiceKeys.chog) || storage.getItem(pendingKeys.chog)), nft: !!(storage.getItem(activeInvoiceKeys.nft) || storage.getItem(pendingKeys.nft)) };
}
export function checkoutSelection(requestedCause = "burundi", preferred?: CheckoutMode, storage = currentStore()) {
  const outstanding = savedCheckoutModes(storage);
  const storedMode = storage.getItem(preferredKey);
  // Explicit tab selection is navigation, not cancellation or a new invoice.
  // Only the selected mode pins its own cause; the other mode stays recoverable.
  const mode: CheckoutMode = preferred ?? (storedMode === "nft" || storedMode === "chog" ? storedMode : outstanding.chog ? "chog" : outstanding.nft ? "nft" : "chog");
  const activeCause = storage.getItem(causeKey(mode)) || pendingCreation(mode,storage)?.input.initiativeId || "burundi";
  if (outstanding[mode] && !(mode === "chog" ? supportsChog(activeCause) : supportsNft(activeCause))) throw new Error("Saved payment initiative is invalid.");
  return { mode, initiativeId: outstanding[mode] ? activeCause : requestedCause, outstanding: outstanding.chog || outstanding.nft };
}
export function rememberMode(mode: CheckoutMode, storage = currentStore()) { storage.setItem(preferredKey, mode); }
export function beginCreation(input: CreationInput, storage = currentStore()): PendingCreation {
  if (savedInvoice(input.mode, storage)) throw new Error("An invoice is already saved. Restore it before creating another payment.");
  const pending = pendingCreation(input.mode, storage);
  if (pending) {
    if (JSON.stringify(pending.input) !== JSON.stringify(input)) throw new Error("Your previous request has not been resolved. Retry it unchanged; do not create another payment.");
    return pending;
  }
  const next = { key: crypto.randomUUID(), input };
  // A failed write MUST prevent the request: never send before recovery is durable.
  storage.setItem(pendingKeys[input.mode], JSON.stringify(next));
  storage.setItem(preferredKey, input.mode);
  announce();
  return next;
}
export function rememberInvoice(mode: CheckoutMode, id: string, storage = currentStore(), initiativeId?: string) {
  if (!validInvoiceId(id)) throw new Error("Invalid invoice recovery ID.");
  const existing = savedInvoice(mode, storage);
  const cause = initiativeId || pendingCreation(mode,storage)?.input.initiativeId || storage.getItem(causeKey(mode)) || "burundi";
  if (!(mode === "chog" ? supportsChog(cause) : supportsNft(cause))) throw new Error("Unsupported payment initiative.");
  if (existing && existing !== id) throw new Error("Another invoice is already saved. Keep both recovery IDs; no existing payment was replaced.");
  if (existing && (storage.getItem(causeKey(mode)) || "burundi") !== cause) throw new Error("Saved payment initiative cannot change.");
  storage.setItem(causeKey(mode), cause);
  storage.setItem(activeInvoiceKeys[mode], id);
  storage.setItem(preferredKey, mode);
  // Only after the validated invoice ID is durably saved is its pending key removed.
  storage.removeItem(pendingKeys[mode]);
  announce();
}
export function clearUnstartedCreation(mode: CheckoutMode, key: string, storage = currentStore()) {
  if (pendingCreation(mode, storage)?.key === key) { storage.removeItem(pendingKeys[mode]); announce(); }
}
export function closeSavedInvoice(mode: CheckoutMode, storage = currentStore()) {
  const id = savedInvoice(mode, storage);
  const history = readHistory(storage);
  if (id && !history.some(item => item.mode === mode && item.id === id)) {
    if (!validInvoiceId(id)) throw new Error("Invalid saved invoice. Contact the operator; it has not been removed.");
    history.push({ mode, id });
    storage.setItem(historyKey, JSON.stringify(history));
  }
  storage.removeItem(activeInvoiceKeys[mode]);
  storage.removeItem(causeKey(mode));
  announce();
}
function readHistory(storage: SessionStore): { mode: CheckoutMode; id: string }[] {
  const value = JSON.parse(storage.getItem(historyKey) || "[]");
  if (!Array.isArray(value) || value.some(item => !item || !["chog", "nft"].includes(item.mode) || !validInvoiceId(item.id))) throw new Error("Saved payment history needs operator recovery.");
  return value;
}
export function recoveryBundle(storage = currentStore()) {
  return JSON.stringify({ version: 1, chog: savedInvoice("chog", storage), nft: savedInvoice("nft", storage), pendingChog: pendingCreation("chog", storage), pendingNft: pendingCreation("nft", storage), history: readHistory(storage) }, null, 2);
}
function creationRetryDelay(response: Response, data: { retryAfterSeconds?: unknown } | null): number | null {
  const header = response.headers.get("Retry-After"), body = data?.retryAfterSeconds;
  const seconds = header === null ? body : /^\d+$/.test(header) ? Number(header) : NaN;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 5) return null;
  // Contradictory or malformed retry instructions must never shorten a limit.
  if (header !== null && body !== undefined && body !== seconds) return null;
  return seconds * 1000;
}
function waitForCreationRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener("abort", cancelled); reject(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, delay);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}
export async function createPaymentRequest(pending: PendingCreation, signal: AbortSignal, request: typeof fetch = fetch, storage?: SessionStore) {
  // Snapshot once: every attempt, including session recovery, is byte-identical.
  const key = pending.key, mode = pending.input.mode, body = JSON.stringify(pending.input);
  const interrupted = () => new Error("The response was interrupted. Your request is saved. Retry the same request; do not create or send another payment.");
  let posts = 0, sessionRenewed = false;
  const send = async () => {
    try {
      signal.throwIfAborted();
      posts++;
      const response = await request("/api/payments/invoices", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body, signal });
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      return { response, data };
    } catch { throw interrupted(); }
  };
  let { response, data } = await send();
  // Three POSTs total, sharing the caller's deadline. A session-recovery POST
  // uses the same budget; refreshing config can happen only once per call.
  while (!response.ok && data?.creationNotStarted !== true && posts < 3) {
    if (response.status === 403 && data?.code === "SESSION_REQUIRED" && !sessionRenewed) {
      sessionRenewed = true;
      let restored = false;
      try {
        signal.throwIfAborted();
        const config = await request("/api/payments/config", { credentials: "same-origin", cache: "no-store", signal });
        signal.throwIfAborted();
        restored = config.ok;
      } catch {
        throw new Error("Connection interrupted while restoring your payment session. Your request is saved. Retry the same request; do not send another payment.");
      }
      if (!restored) break;
      ({ response, data } = await send());
      continue;
    }
    const transient = response.status === 409 && data?.code === "REQUEST_PENDING" || response.status === 429 && data?.code === "RATE_LIMITED";
    const delay = transient ? creationRetryDelay(response, data) : null;
    if (delay === null) break;
    try { await waitForCreationRetry(delay, signal); }
    catch { throw interrupted(); }
    ({ response, data } = await send());
  }
  if (!response.ok) {
    if (data?.creationNotStarted === true) clearUnstartedCreation(mode, key, storage);
    if (data?.creationNotStarted === true && data?.code === "BRIDGE_COST_LIMIT") throw new Error("Bridge fees are too high for this amount. No payment was created. Increase the amount or try again later.");
    if (data?.creationNotStarted === true && data?.code === "NFT_NOT_OWNED") throw new Error("This NFT is not held by your wallet. No payment was created. Try again: your current CHOG NFT will be found automatically.");
    if (data?.creationNotStarted === true && data?.code === "NFT_DAILY_LIMIT") throw new Error("Your wallet or NFT already has today's donation. Try after 00:00 UTC. No payment was created.");
    if (data?.code === "PAYMENTS_NOT_READY") throw new Error(data?.creationNotStarted === true ? "The payment connection is recovering. No payment was created. Try again when payments are available." : "The payment connection is recovering. Your original request is saved. Retry it when payments are available; do not send another payment.");
    if (data?.creationNotStarted === true) throw new Error("No payment was created. Check your details and availability, then try again.");
    switch (data?.code) {
      case "REQUEST_PENDING": throw new Error("Your original request is still being checked. Retry this same saved request shortly; do not send another payment.");
      case "RATE_LIMITED": throw new Error("Too many payment requests. Wait briefly, then retry this same saved request; do not send another payment.");
      case "SESSION_REQUIRED": throw new Error("Your payment session could not be restored. Keep this saved request and retry from this same page; do not send another payment.");
      case "IDEMPOTENCY_CONFLICT": throw new Error("This saved request conflicts with an existing payment. Keep this tab and contact support; do not create or send another payment.");
      case "INTEGRITY_HOLD": throw new Error("Payments are paused for a recovery check. Your original request is saved. Retry it when the service is available; do not send another payment.");
    }
    if (response.status === 403) throw new Error("Payment access was rejected. Keep this saved request and contact support; do not send another payment.");
    // A gateway failure says nothing about whether the worker accepted a POST.
    // Leave its durable key intact and let the donor explicitly retry it.
    if (response.status === 502 || response.status === 504) throw new Error("The payment gateway is temporarily unavailable. Your original request is saved. Retry this same request; do not send another payment.");
    throw new Error("The request is not resolved yet. Retry this same request; do not send another payment. Your recovery reference is saved.");
  }
  return data as unknown;
}
