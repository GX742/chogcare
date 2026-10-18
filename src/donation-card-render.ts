// A static weight keeps exported numerals equally bold in Safari and Chrome.
// Manrope 5.3.0 / SIL OFL; license lives beside the bundled font.
import fontUrl from "./assets/donation-cards/manrope-latin-800-normal.woff2?url";
import animalTemplate from "./assets/donation-cards/animal-ethics.webp";
import solarTemplate from "./assets/donation-cards/solar-foundation.webp";
import vidaTemplate from "./assets/donation-cards/vida-verde.webp";
import schoolTemplate from "./assets/donation-cards/school-supplies.webp";
import { CARD_AMOUNT_BOX, CARD_HEIGHT, CARD_WIDTH, cardAmountLayout, type DonationCard } from "./donation-card.ts";

const FONT = "ChogCare donation card";
const templates: Record<string, string> = { "animal-ethics": animalTemplate, "solar-foundation": solarTemplate, "vida-verde": vidaTemplate, "school-supplies": schoolTemplate, burundi: solarTemplate };
let fontRequest: Promise<void> | undefined;
function loadFont() {
  return fontRequest ??= (async () => {
    const response = await fetch(fontUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Donation font unavailable.");
    const face = new FontFace(FONT, await response.arrayBuffer(), { weight: "800", style: "normal" });
    await face.load(); document.fonts.add(face);
  })().catch(() => { fontRequest = undefined; throw new Error("Donation font unavailable."); });
}
function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    // Only bundled same-origin artwork; no donor URL, wallet or remote avatar.
    if (new URL(url, location.href).origin !== location.origin) { reject(new Error("Invalid artwork origin.")); return; }
    const img = new Image(); img.decoding = "async";
    const clean = () => { img.onload = null; img.onerror = null; signal.removeEventListener("abort", abort); };
    const abort = () => { clean(); img.src = ""; reject(signal.reason); };
    img.onload = () => { clean(); resolve(img); };
    img.onerror = () => { clean(); reject(new Error("Donation artwork unavailable.")); };
    signal.addEventListener("abort", abort, { once: true }); img.src = url;
  });
}
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
}
function centerText(ctx: CanvasRenderingContext2D, value: string, center: number, baseline: number, size: number, color: string) {
  ctx.font = `800 ${size}px "${FONT}"`; ctx.fillStyle = color; ctx.textAlign = "left";
  const m = ctx.measureText(value);
  const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  ctx.fillText(value, center - width / 2 + m.actualBoundingBoxLeft, baseline);
}
function drawReceiptPanel(ctx: CanvasRenderingContext2D, card: DonationCard, coin: HTMLImageElement) {
  const gradient = ctx.createLinearGradient(891, 472, 1592, 774);
  gradient.addColorStop(0, "#40164e"); gradient.addColorStop(1, "#381347");
  rounded(ctx, 891, 472, 701, 301, 32); ctx.fillStyle = gradient; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#793894"; ctx.stroke();
  rounded(ctx, 913, 567, 465, 176, 25); ctx.fillStyle = "#2b103d"; ctx.fill();
  ctx.font = `800 ${card.mode === "nft" ? 36 : 42}px "${FONT}"`; ctx.fillStyle = "#ebc3f7";
  ctx.fillText(card.mode === "nft" ? "From the NFT pool" : "I donated", 920, 539);
  ctx.drawImage(coin, 1394, 516, 174, 174);
  centerText(ctx, card.mode === "nft" ? "USDC" : "$CHOG", 1482, 729, 45, "#ffa3d7");
}
function drawBurundi(ctx: CanvasRenderingContext2D, photo: HTMLImageElement) {
  // Archived invoices still get the correct cause, never a Solar-labelled card.
  ctx.save(); rounded(ctx, 44, 66, 1584, 801, 44); ctx.clip();
  const background = ctx.createLinearGradient(44, 211, 1628, 867);
  background.addColorStop(0, "#200a2e"); background.addColorStop(1, "#250b35");
  ctx.fillStyle = background; ctx.fillRect(44, 212, 1584, 655); ctx.restore();
  ctx.save(); rounded(ctx, 79, 242, 778, 580, 32); ctx.clip();
  const scale = Math.max(778 / photo.naturalWidth, 580 / photo.naturalHeight);
  ctx.drawImage(photo, 79 + (778 - photo.naturalWidth * scale) / 2, 242 + (580 - photo.naturalHeight * scale) / 2, photo.naturalWidth * scale, photo.naturalHeight * scale); ctx.restore();
  ctx.font = `800 70px "${FONT}"`; ctx.fillStyle = "#fff8ff";
  ctx.fillText("Perfect Villages", 911, 331); ctx.fillStyle = "#ed9ae9"; ctx.fillText("in Burundi", 911, 418);
}

export async function renderDonationCard(card: DonationCard, signal: AbortSignal): Promise<Blob> {
  if (!Object.hasOwn(templates, card.initiativeId)) throw new Error("Unknown donation initiative.");
  const [template, coin, photo] = await Promise.all([
    loadImage(templates[card.initiativeId], signal),
    card.mode === "nft" || card.initiativeId === "burundi" ? loadImage("/chog-donation-coin-256.webp", signal) : null,
    card.initiativeId === "burundi" ? loadImage("/station-photos/burundi.jpg", signal) : null,
    loadFont(),
  ]);
  signal.throwIfAborted();
  const canvas = document.createElement("canvas"); canvas.width = CARD_WIDTH; canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Image export unavailable.");
  ctx.drawImage(template, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  if (photo) drawBurundi(ctx, photo);
  if (coin) drawReceiptPanel(ctx, card, coin);
  ctx.textBaseline = "alphabetic";
  const rows = cardAmountLayout(card.amount, (value, size) => {
    ctx.font = `800 ${size}px "${FONT}"`;
    const m = ctx.measureText(value);
    return { width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
  }, card.rounded);
  const box = CARD_AMOUNT_BOX;
  for (const row of rows) centerText(ctx, row.text, box.x + box.width / 2, row.baseline, row.size, "#fff8ff");
  if (card.rounded) centerText(ctx, "Approx. amount", box.x + box.width / 2, box.y + box.height - 8, 18, "#cda5de");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    canvas.width = canvas.height = 1;
    if (signal.aborted) reject(signal.reason);
    else if (blob?.type === "image/png" && blob.size) resolve(blob);
    else reject(new Error("PNG export unavailable."));
  }, "image/png"));
}

export function cardPreviewData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Image preview unavailable."));
    reader.onerror = () => reject(new Error("Image preview unavailable."));
    reader.readAsDataURL(blob);
  });
}
