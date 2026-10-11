import { formatUnits, isAddress, parseUnits, zeroAddress } from "viem";

export type CheckoutMode = "chog" | "nft";
export type PreviewInvoice = {
  kind: "preview";
  id: string;
  initiativeId: string;
  mode: CheckoutMode;
  amount: string;
  asset: "CHOG" | "MON";
  holderAddress?: string;
};

// Preview deliberately has no deposit address, payment URI, expiry or paid state.
// Issuing a real invoice requires a durable backend and an operational processor.
export function createPreviewInvoice(mode: CheckoutMode, amount: string, holderAddress: string, initiativeId: string): PreviewInvoice {
  if (mode !== "chog" && mode !== "nft") throw new Error("Choose a supported payment method.");
  if (!/^[a-z0-9-]{1,64}$/.test(initiativeId)) throw new Error("Choose an initiative first.");
  const normalized = amount.trim();
  if (!/^\d{1,60}(\.\d{1,18})?$/.test(normalized)) throw new Error("Enter an amount using digits and a decimal point, with up to 18 decimal places.");
  const units = parseUnits(normalized, 18);
  if (units <= 0n || units > (2n ** 256n - 1n)) throw new Error("Enter a valid token amount.");
  if (mode === "chog" && units < parseUnits("300", 18)) throw new Error("The minimum donation is 300 CHOG.");
  if (mode === "chog" && units > parseUnits("1000000", 18)) throw new Error("The maximum donation is 1,000,000 CHOG.");
  const holder = holderAddress.trim();
  if (mode === "nft") {
    if (units !== parseUnits("1", 18)) throw new Error("The proposed verification transfer is exactly 1 MON.");
    if (!isAddress(holder) || holder.toLowerCase() === zeroAddress) throw new Error("Enter the public Monad address that holds your CHOG NFT.");
  }
  return {
    kind: "preview", id: crypto.randomUUID(), initiativeId, mode,
    amount: formatUnits(units, 18), asset: mode === "chog" ? "CHOG" : "MON",
    ...(mode === "nft" ? { holderAddress: holder } : {}),
  };
}

export function previewQrText(invoice: PreviewInvoice): string {
  // Plain text only. Never encode a payable ethereum: URI or a real address in a demo QR.
  return `CHOGCARE PREVIEW - NOT A PAYMENT\n${invoice.amount} ${invoice.asset}\n${invoice.initiativeId}\nReference: ${invoice.id}\nNo deposit address has been issued. Do not send funds.`;
}
