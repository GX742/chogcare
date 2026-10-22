export type NftPoolImpact = { donatedUsdc: string; donations: number };

const unitsPattern = /^(?:0|[1-9]\d{0,77})$/;

// Missing or malformed statistics are unavailable, never a fabricated zero.
export function parseNftPoolImpact(value: unknown): NftPoolImpact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { donatedUsdc, donations } = value as Record<string, unknown>;
  if (typeof donatedUsdc !== "string" || donatedUsdc.match(unitsPattern)?.[0] !== donatedUsdc ||
      !Number.isSafeInteger(donations) || (donations as number) < 0 || (donations as number) > 1_000_000 ||
      (donatedUsdc === "0") !== (donations === 0)) return null;
  return { donatedUsdc, donations: donations as number };
}

export function presentPoolUsdc(units: string): string {
  if (units.match(unitsPattern)?.[0] !== units) throw new TypeError("Invalid pool total.");
  const amount = BigInt(units);
  const whole = (amount / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = String(amount % 1_000_000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}
