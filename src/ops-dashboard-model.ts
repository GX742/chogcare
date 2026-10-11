import { isPositiveChogAmount, formatChogAmount } from "./leaderboard-model.ts";
import { publicBroadcastOrigin } from "./broadcast-source.ts";

export type ServiceState = "ready" | "paused" | "offline";
export type DashboardSnapshot = {
  checkedAt: number;
  payments: { state: ServiceState; nftState: ServiceState; availableClaims: number | null; maxDailyClaims: 3; subsidyUsdc: "1.00"; dailyPoolLimitUsdc: "3.00" };
  impact: { chogDonated: string; donations: number } | null;
  station: { state: "unknown" };
  broadcast: { state: "unknown" };
};
export type BridgeEstimate = {
  checkedAt: number; expiresAt: number; amountChog: string; poolContributionChog: string; totalChog: string;
  conversionMinimumUsdc: string; expectedCharityUsd: string; minimumCharityUsd: string;
  bridgeFeeUsd: string; bridgeFeePercent: string; estimatedSeconds: number | null; notice: string;
};
export type BroadcastObservation = { sequence: string; activityAt: number };
export const bridgeAmounts = ["300", "3000", "30000"] as const;
export type BridgeAmount = typeof bridgeAmounts[number];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function decimal(value: unknown, whole = 20, fraction = 6): value is string { return typeof value === "string" && value.match(new RegExp(`^[0-9]{1,${whole}}${fraction > 0 ? `(?:\\.[0-9]{1,${fraction}})?` : ""}$`))?.[0] === value; }
function decimalUnits(value: string): bigint { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")); }
function state(value: unknown): value is ServiceState { return value === "ready" || value === "paused" || value === "offline"; }
export function parseDashboardSnapshot(value: unknown): DashboardSnapshot | null {
  if (!record(value) || !timestamp(value.checkedAt) || !record(value.payments) || !record(value.station) || !record(value.broadcast)) return null;
  const payment = value.payments;
  if (!state(payment.state) || !state(payment.nftState) || payment.maxDailyClaims !== 3 || payment.subsidyUsdc !== "1.00" || payment.dailyPoolLimitUsdc !== "3.00" ||
    (payment.integrityLocked !== undefined && typeof payment.integrityLocked !== "boolean") || (payment.integrityLocked === true && (payment.state === "ready" || payment.nftState === "ready")) ||
    (payment.availableClaims !== null && (!Number.isSafeInteger(payment.availableClaims) || (payment.availableClaims as number) < 0 || (payment.availableClaims as number) > 3)) ||
    value.station.state !== "unknown" || value.broadcast.state !== "unknown") return null;
  let impact: DashboardSnapshot["impact"] = null;
  if (value.impact !== null) {
    if (!record(value.impact) || !(value.impact.chogDonated === "0" || isPositiveChogAmount(value.impact.chogDonated)) || !Number.isSafeInteger(value.impact.donations) || (value.impact.donations as number) < 0) return null;
    impact = { chogDonated: value.impact.chogDonated as string, donations: value.impact.donations as number };
  }
  return {
    checkedAt: value.checkedAt,
    payments: { state: payment.state, nftState: payment.nftState, availableClaims: payment.availableClaims as number | null, maxDailyClaims: 3, subsidyUsdc: "1.00", dailyPoolLimitUsdc: "3.00" },
    impact, station: { state: "unknown" }, broadcast: { state: "unknown" },
  };
}
export function dashboardChogAmount(value: string): string { return value === "0" ? "0" : formatChogAmount(value); }
export function formatEstimateUsd(value: string): string {
  if (!decimal(value)) throw new Error("Invalid estimate value.");
  const [whole, fraction = ""] = value.split(".");
  const grouped = whole.replace(/^0+(?=[0-9])/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const places = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${grouped}.${places}`;
}
export function parseBridgeEstimate(value: unknown, requestedAmount: BridgeAmount, now = Date.now()): BridgeEstimate | null {
  if (!record(value) || !timestamp(value.checkedAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.checkedAt || value.expiresAt <= now || value.checkedAt > now + 30_000 ||
    value.amountChog !== requestedAmount || value.poolContributionChog !== String(BigInt(requestedAmount) / 10n) || value.totalChog !== String(BigInt(requestedAmount) * 11n / 10n) ||
    !decimal(value.conversionMinimumUsdc) || decimalUnits(value.conversionMinimumUsdc) <= 0n || !decimal(value.expectedCharityUsd) || !decimal(value.minimumCharityUsd) || !decimal(value.bridgeFeeUsd) || !decimal(value.bridgeFeePercent, 3) ||
    decimalUnits(value.expectedCharityUsd) < decimalUnits(value.minimumCharityUsd) || decimalUnits(value.minimumCharityUsd) <= 0n || decimalUnits(value.bridgeFeePercent) > 100_000_000n ||
    (value.estimatedSeconds !== null && (!Number.isSafeInteger(value.estimatedSeconds) || (value.estimatedSeconds as number) < 1 || (value.estimatedSeconds as number) > 86400)) ||
    typeof value.notice !== "string" || value.notice.length > 400 || /[\x00-\x1f\x7f]/.test(value.notice)) return null;
  return {
    checkedAt: value.checkedAt, expiresAt: value.expiresAt, amountChog: requestedAmount,
    poolContributionChog: value.poolContributionChog, totalChog: value.totalChog,
    conversionMinimumUsdc: value.conversionMinimumUsdc, expectedCharityUsd: value.expectedCharityUsd, minimumCharityUsd: value.minimumCharityUsd,
    bridgeFeeUsd: value.bridgeFeeUsd, bridgeFeePercent: value.bridgeFeePercent,
    estimatedSeconds: value.estimatedSeconds as number | null, notice: value.notice,
  };
}
// A reachable master playlist is not proof of a running broadcast. Accept only
// an Owncast media playlist; activity requires fresh media time or progression.
export function readBroadcastManifest(text: string, source: string): { variant: string | null; sequence: string | null; freshAt: number | null; ended: boolean } | null {
  if (text.length > 32_768 || !text.trimStart().startsWith("#EXTM3U")) return null;
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const variantIndex = lines.findIndex(line => line.startsWith("#EXT-X-STREAM-INF:"));
  let variant: string | null = null;
  if (variantIndex >= 0) {
    const path = lines[variantIndex + 1];
    try {
      const url = new URL(path, source);
      if (path && url.origin === publicBroadcastOrigin && !url.username && !url.password && !url.search && !url.hash && /^\/hls\/[a-zA-Z0-9/_-]+\.m3u8$/.test(url.pathname)) variant = url.href;
    } catch { /* An untrusted playlist never chooses another fetch origin. */ }
  }
  const rawSequence = lines.find(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))?.slice(22) ?? null;
  const sequence = rawSequence && rawSequence.match(/^[0-9]{1,20}$/)?.[0] === rawSequence ? rawSequence : null;
  const times = lines.filter(line => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")).map(line => Date.parse(line.slice(25))).filter(Number.isFinite);
  return { variant, sequence, freshAt: times.length ? Math.max(...times) : null, ended: lines.includes("#EXT-X-ENDLIST") };
}
export function observeBroadcast(previous: BroadcastObservation | null, manifest: ReturnType<typeof readBroadcastManifest>, now = Date.now()): { observation: BroadcastObservation | null; live: boolean } {
  if (!manifest || manifest.ended || !manifest.sequence) return { observation: null, live: false };
  const freshTime = manifest.freshAt !== null && manifest.freshAt <= now + 30_000 && now - manifest.freshAt < 45_000;
  const progressed = previous !== null && previous.sequence !== manifest.sequence;
  const activityAt = freshTime || progressed ? now : previous?.activityAt ?? 0;
  return { observation: { sequence: manifest.sequence, activityAt }, live: activityAt > 0 && now - activityAt < 45_000 };
}
