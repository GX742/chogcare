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
export function assertUnpaidCheckout(id: string, invoice: { id: string; state: string; depositHash?: string | null; destinationHash?: string | null; observedDestinationHash?: string | null }) {
  if (!validInvoiceId(id) || invoice.id !== id || invoice.state !== "awaiting-payment" || invoice.depositHash || invoice.destinationHash || invoice.observedDestinationHash) throw new Error("This payment may be processing. Keep it open; do not pay again.");
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
export function checkoutSelection(requestedCause = "burundi", preferred?: CheckoutMode, storage = currentStore()) {
  const outstanding = { chog: !!(storage.getItem(activeInvoiceKeys.chog) || storage.getItem(pendingKeys.chog)), nft: !!(storage.getItem(activeInvoiceKeys.nft) || storage.getItem(pendingKeys.nft)) };
  const storedMode = storage.getItem(preferredKey);
  const wanted = preferred || (storedMode === "nft" ? "nft" : "chog");
  const mode: CheckoutMode = outstanding[wanted] ? wanted : outstanding.chog ? "chog" : outstanding.nft ? "nft" : wanted;
  const activeCause = storage.getItem(causeKey(mode)) || pendingCreation(mode,storage)?.input.initiativeId || "burundi";
  if (outstanding[mode] && !(mode === "chog" ? supportsChog(activeCause) : supportsNft(activeCause))) throw new Error("Saved payment initiative is invalid.");
  return { mode, initiativeId: outstanding.chog || outstanding.nft ? activeCause : requestedCause, outstanding: outstanding.chog || outstanding.nft };
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
export async function createPaymentRequest(pending: PendingCreation, signal: AbortSignal, request: typeof fetch = fetch, storage?: SessionStore) {
  let response: Response;
  try {
    response = await request("/api/payments/invoices", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: JSON.stringify(pending.input), signal });
  } catch {
    throw new Error("The response was interrupted. Your request is saved. Retry the same request; do not create or send another payment.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (data?.creationNotStarted === true) clearUnstartedCreation(pending.input.mode, pending.key, storage);
    if (data?.creationNotStarted === true && data?.code === "BRIDGE_COST_LIMIT") throw new Error("Bridge fees are too high for this amount. No payment was created. Increase the amount or try again later.");
    if (data?.creationNotStarted === true && data?.code === "NFT_NOT_OWNED") throw new Error("This NFT is not held by your wallet. No payment was created. Try again: your current CHOG NFT will be found automatically.");
    if (data?.creationNotStarted === true && data?.code === "NFT_DAILY_LIMIT") throw new Error("Your wallet or NFT already has today's donation. Try after 00:00 UTC. No payment was created.");
    throw new Error(data?.creationNotStarted === true ? "No payment was created. Check your details and availability, then try again." : "The request is not resolved yet. Retry this same request; do not send another payment. Your recovery reference is saved.");
  }
  return data as unknown;
}
