import { donationShare, initiativeNames } from "./donation-share.ts";
import { formatDonationAmount } from "./donation-amount.ts";

export type DonationCardInput = { state: string; mode: "chog" | "nft"; amount: string; initiativeId: string };
export type DonationCard = { key: string; initiativeId: string; initiative: string; mode: "chog" | "nft"; exactAmount: string; amount: string; rounded: boolean; filename: string; alt: string };
export const CARD_WIDTH = 1672;
export const CARD_HEIGHT = 941;
export const CARD_AMOUNT_BOX = Object.freeze({ x: 937, y: 588, width: 416, height: 132 });

export function donationCard(input: DonationCardInput): DonationCard | null {
  if (!donationShare(input, "https://chogcare.xyz/")) return null;
  const presentation = formatDonationAmount(input.amount, input.mode), amount = presentation.display;
  const readable = amount.startsWith("<") ? `less than ${amount.slice(1)}` : `${presentation.rounded ? "approximately " : ""}${amount}`;
  const initiative = initiativeNames[input.initiativeId];
  return {
    key: `${input.mode}:${input.initiativeId}:${input.amount}`,
    initiativeId: input.initiativeId, initiative, mode: input.mode, exactAmount: presentation.exactAmount, amount, rounded: presentation.rounded,
    filename: `chogcare-${input.initiativeId}-${amount.replaceAll(",", "").replaceAll("<", "less-than-")}-${input.mode === "chog" ? "chog" : "usdc"}.png`,
    alt: input.mode === "chog" ? `I donated ${readable} $CHOG to ${initiative} through ChogCare.` : `${readable} USDC from the ChogCare NFT pool for ${initiative}.`,
  };
}

export type CardTextMetrics = { width: number; ascent: number; descent: number };
export type CardAmountRow = { text: string; size: number; baseline: number };
// One readable line, with room for a small approximation label when needed.
export function cardAmountLayout(amount: string, measure: (text: string, size: number) => CardTextMetrics, rounded = false): CardAmountRow[] {
  if (amount.match(/^(?:\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|<0\.01)$/)?.[0] !== amount) throw new Error("Invalid card amount.");
  const box = CARD_AMOUNT_BOX;
  const availableHeight = box.height - (rounded ? 28 : 0);
  for (let size = 112; size >= 40; size -= 2) {
    const ink = measure(amount, size), height = ink.ascent + ink.descent;
    if ([ink.width, ink.ascent, ink.descent].every(Number.isFinite) && ink.width > 0 && ink.width <= box.width && ink.ascent >= 0 && ink.descent >= 0 && height > 0 && height <= availableHeight) {
      return [{ text: amount, size, baseline: box.y + (availableHeight - height) / 2 + ink.ascent }];
    }
  }
  throw new Error("Card amount does not fit.");
}
