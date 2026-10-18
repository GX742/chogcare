import { donationShare, initiativeNames } from "./donation-share.ts";

export type DonationCardInput = { state: string; mode: "chog" | "nft"; amount: string; initiativeId: string };
export type DonationCard = { key: string; initiativeId: string; initiative: string; mode: "chog" | "nft"; amount: string; filename: string; alt: string };
export const CARD_WIDTH = 1672;
export const CARD_HEIGHT = 941;
export const CARD_AMOUNT_BOX = Object.freeze({ x: 937, y: 588, width: 416, height: 132 });

export function donationCard(input: DonationCardInput): DonationCard | null {
  if (!donationShare(input, "https://chogcare.xyz/")) return null;
  const [whole, fraction] = input.amount.split(".");
  const amount = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  const initiative = initiativeNames[input.initiativeId];
  return {
    key: `${input.mode}:${input.initiativeId}:${input.amount}`,
    initiativeId: input.initiativeId, initiative, mode: input.mode, amount,
    filename: `chogcare-${input.initiativeId}-${input.amount}-${input.mode === "chog" ? "chog" : "usdc"}.png`,
    alt: input.mode === "chog" ? `I donated ${amount} $CHOG to ${initiative} through ChogCare.` : `${amount} USDC from the ChogCare NFT pool for ${initiative}.`,
  };
}

export type CardTextMetrics = { width: number; ascent: number; descent: number };
export type CardAmountRow = { text: string; size: number; baseline: number };
// Exact decimal strings throughout: no Number conversion, rounding or ellipsis.
// Exceptionally precise amounts use a large whole part and a smaller decimal
// continuation, rather than squeezing 18 decimal places into unreadable type.
export function cardAmountLayout(amount: string, measure: (text: string, size: number) => CardTextMetrics): CardAmountRow[] {
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{1,18})?$/.test(amount)) throw new Error("Invalid card amount.");
  const box = CARD_AMOUNT_BOX;
  const fits = (text: string, size: number) => {
    const m = measure(text, size);
    return Number.isFinite(m.width) && m.width > 0 && m.width <= box.width && m.ascent + m.descent <= box.height;
  };
  let rows: { text: string; size: number }[] = [];
  for (let size = 112; size >= 64; size -= 2) {
    if (fits(amount, size)) { rows = [{ text: amount, size }]; break; }
  }
  if (!rows.length) {
    const [whole, fraction] = amount.split(".");
    for (const [text, maximum] of fraction ? [[whole, 80], [`.${fraction}`, 44]] as const : [[whole, 62]] as const) {
      let size = maximum;
      while (size >= 28 && !fits(text, size)) size -= 2;
      if (size < 28) throw new Error("Card amount does not fit.");
      rows.push({ text, size });
    }
  }
  const gap = rows.length > 1 ? 12 : 0;
  const height = rows.reduce((sum, row) => { const m = measure(row.text, row.size); return sum + m.ascent + m.descent; }, 0) + gap * (rows.length - 1);
  if (!Number.isFinite(height) || height <= 0 || height > box.height) throw new Error("Card amount does not fit.");
  let top = box.y + (box.height - height) / 2;
  return rows.map(row => {
    const m = measure(row.text, row.size), baseline = top + m.ascent;
    top += m.ascent + m.descent + gap;
    return { ...row, baseline };
  });
}
