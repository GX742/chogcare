import { initiativeNames } from "./donation-share.ts";

export type LeaderboardEntry = {
  rank: number;
  nickname: string;
  initiativeId: string;
  amount: string;
  avatarImage: string | null;
  avatarName: string | null;
  status: "confirming" | "delivered";
};

const chogAmount = /^[0-9]{1,78}(?:\.[0-9]{1,18})?$/;
const avatarImage = /^https:\/\/gateway\.pinata\.cloud\/ipfs\/[a-z0-9]{46,90}\/([a-zA-Z0-9._/-]{1,180})$/;

export function isPositiveChogAmount(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // Compare the complete match too: JavaScript's $ also permits a final newline.
  return value.match(chogAmount)?.[0] === value && /[1-9]/.test(value);
}

export function presentChogAmount(value: string): { display: string; rounded: boolean } {
  if (!isPositiveChogAmount(value)) throw new TypeError("Invalid CHOG amount.");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  const centUnits = 10n ** 16n, cents = (units + centUnits / 2n) / centUnits;
  const rounded = units !== cents * centUnits;
  if (cents === 0n) return { display: "<0.01", rounded: true };
  const grouped = (cents / 100n).toString().replace(/\B(?=([0-9]{3})+(?![0-9]))/g, ",");
  const decimals = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return { display: grouped + (decimals ? `.${decimals}` : ""), rounded };
}

// The operator dashboard retains its existing non-upward four-decimal display.
// Public care-board presentation uses presentChogAmount instead.
export function formatChogAmount(value: string): string {
  if (!isPositiveChogAmount(value)) throw new TypeError("Invalid CHOG amount.");
  const [whole, rawFraction = ""] = value.split(".");
  const grouped = whole.replace(/^0+(?=[0-9])/, "").replace(/\B(?=([0-9]{3})+(?![0-9]))/g, ",");
  const fraction = rawFraction.replace(/0+$/, "");
  return grouped + (fraction ? `.${fraction.slice(0, 4)}${fraction.length > 4 ? "…" : ""}` : "");
}

export function safeLeaderboardAvatarImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(avatarImage);
  if (!match || match[0] !== value || match[1].split("/").some(part => part === "." || part === "..")) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseLeaderboardEntries(value: unknown): LeaderboardEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  const entries: LeaderboardEntry[] = [];
  for (const item of value.entries) {
    if (!isRecord(item) || !Number.isSafeInteger(item.rank) || (item.rank as number) < 1 ||
      typeof item.nickname !== "string" || [...item.nickname].length < 2 || [...item.nickname].length > 24 || /[\x00-\x1f\x7f]/.test(item.nickname) || !isPositiveChogAmount(item.amount) ||
      typeof item.initiativeId !== "string" || !Object.hasOwn(initiativeNames, item.initiativeId) ||
      (item.status !== "confirming" && item.status !== "delivered")) continue;
    // Pick the public fields rather than copying wallet/invoice identities or
    // other unexpected API properties into frontend state.
    entries.push({
      rank: item.rank as number,
      nickname: item.nickname,
      initiativeId: item.initiativeId,
      amount: item.amount,
      avatarImage: safeLeaderboardAvatarImage(item.avatarImage),
      avatarName: typeof item.avatarName === "string" && item.avatarName.length <= 80 && !/[\x00-\x1f\x7f]/.test(item.avatarName) ? item.avatarName : null,
      status: item.status,
    });
    if (entries.length === 20) break;
  }
  return entries;
}
