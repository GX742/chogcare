import { parseLeaderboardEntries } from "./leaderboard-model.ts";
import { parseNftPoolImpact } from "./leaderboard-pool.ts";

export async function loadPublicCareBoard(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher("/api/payments/leaderboard", { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("Leaderboard unavailable.");
  const raw: unknown = await response.json();
  if (signal.aborted) throw signal.reason || new Error("Cancelled leaderboard request.");
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { entries?: unknown }).entries)) throw new Error("Invalid leaderboard response.");
  const entries = parseLeaderboardEntries(raw);
  if ((raw as { entries: unknown[] }).entries.length && !entries.length) throw new Error("Invalid leaderboard entries.");
  return { entries, pool: parseNftPoolImpact((raw as { pool?: unknown }).pool) };
}

export async function loadPublicLeaderboard(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  return (await loadPublicCareBoard(signal, fetcher)).entries;
}
