export type PublicImpact = { chogDonated: string; donations: number; estimatedUsd: string | null };
const amountPattern = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && value.match(pattern)?.[0] === value;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parsePublicImpact(dashboard: unknown, rate: unknown, now = Date.now()): PublicImpact {
  if (!record(dashboard) || !record(dashboard.impact)) throw new Error("Donation total unavailable.");
  const { chogDonated, donations } = dashboard.impact;
  if (!matches(amountPattern, chogDonated) || !Number.isSafeInteger(donations) || Number(donations) < 0 || Number(donations) > 1_000_000) throw new Error("Invalid donation total.");
  let estimatedUsd: string | null = null;
  if (record(rate) && rate.referenceChog === "300" && matches(/^[1-9]\d{0,9}$/, rate.estimatedUsdMicros) &&
      BigInt(rate.estimatedUsdMicros) <= 1_000_000_000n && typeof rate.quotedAt === "number" &&
      Number.isSafeInteger(rate.quotedAt) && rate.quotedAt <= now + 60_000 && now - rate.quotedAt <= 120_000) {
    const [whole, fraction = ""] = chogDonated.split(".");
    const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    const denominator = 300n * 10n ** 18n * 10_000n;
    const cents = (units * BigInt(rate.estimatedUsdMicros) + denominator / 2n) / denominator;
    estimatedUsd = `$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
  }
  return { chogDonated, donations: donations as number, estimatedUsd };
}

export async function loadPublicImpact(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PublicImpact> {
  const get = async (path: string) => {
    const response = await fetcher(path, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error("Donation total unavailable.");
    return response.json() as Promise<unknown>;
  };
  const [dashboard, rate] = await Promise.all([
    get("/api/payments/dashboard"),
    get("/api/payments/chog-rate").catch(() => null),
  ]);
  if (signal.aborted) throw signal.reason || new Error("Cancelled donation total request.");
  return parsePublicImpact(dashboard, rate);
}
