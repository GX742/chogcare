import { createHash } from "node:crypto";
import { parseLeaderboardEntries, presentChogAmount } from "../src/leaderboard-model.ts";
import { stationNickname } from "../server/station-events.mjs";
import { fetchStationAvatar } from "./station-avatar.mjs";

const ENDPOINT = "http://127.0.0.1:4174/api/payments/leaderboard";
const MAX_BYTES = 32 * 1024, IMAGE_BYTES = 64 * 64 * 2;
const REFRESH_MS = 30_000, CACHE_MS = 120_000, DEADLINE_MS = 2000;
const copyCard = card => card ? { ...card, image: card.image ? Buffer.from(card.image) : null } : null;

// Read-only public presentation. No financial database, wallet lookup, payment
// request or serial transport belongs here. Donation ticks never await this work.
export function createStationLeaderboard({ fetcher = fetch, avatarLoader = fetchStationAvatar, now = Date.now, endpoint = ENDPOINT } = {}) {
  if (![ENDPOINT, "https://45.38.60.159/api/payments/leaderboard"].includes(endpoint)) throw Error("Unsupported station leaderboard endpoint.");
  let closed = false, generation = 0, rows = [], cursor = 0;
  let loadedAt = -Infinity, attemptedAt = -Infinity, refreshTask = null, nextTask = null;
  let activeRead = null, finishClose;
  const closedSignal = new Promise(resolve => { finishClose = resolve; });
  const avatars = new Map(), avatarTasks = new Map();
  const fresh = (at, lifetime) => Number.isFinite(at) && now() >= at && now() - at < lifetime;
  const clear = () => { rows = []; cursor = 0; loadedAt = -Infinity; generation++; avatars.clear(); };
  const expire = () => { if (rows.length && !fresh(loadedAt, CACHE_MS)) clear(); };

  async function readBoard() {
    const controller = new AbortController();
    let reader = null, body = null, timer;
    const stop = () => {
      controller.abort();
      try { void (reader ?? body)?.cancel().catch(() => {}); } catch { /* Already released. */ }
    };
    activeRead = stop;
    const operation = async () => {
      try {
        const response = await fetcher(endpoint, {
          headers: { Accept: "application/json" }, credentials: "omit",
          redirect: "error", signal: controller.signal,
        });
        body = response.body;
        if (controller.signal.aborted || !response.ok || response.redirected ||
            (response.url && response.url !== endpoint) || !body) return null;
        const length = response.headers.get("content-length");
        if (length !== null && (length.length > 16 || !/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))) return null;
        reader = body.getReader();
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) return null;
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) return null;
            chunks.push(Buffer.from(value));
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock(); reader = null;
        }
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
        if (!raw || !Array.isArray(raw.entries)) return null;
        const parsed = parseLeaderboardEntries(raw), result = [], ranks = new Set();
        for (const entry of parsed) {
          if (entry.rank > 20 || ranks.has(entry.rank)) continue;
          const amount = presentChogAmount(entry.amount).display;
          if (amount.length > 110) continue;
          result.push({ rank: entry.rank, nick: stationNickname(entry.nickname), amount, avatar: entry.avatarImage });
          ranks.add(entry.rank);
          if (result.length === 5) break;
        }
        // An invalid nonempty reply is an outage, not evidence of an empty board.
        return raw.entries.length && !result.length ? null : result;
      } catch { return null; }
    };
    try {
      return await Promise.race([
        operation(), closedSignal.then(() => null),
        new Promise(resolve => { timer = setTimeout(() => { stop(); resolve(null); }, DEADLINE_MS); }),
      ]);
    } finally {
      clearTimeout(timer); stop();
      if (activeRead === stop) activeRead = null;
    }
  }

  function refresh() {
    if (closed) return Promise.resolve();
    if (refreshTask) return refreshTask;
    attemptedAt = now();
    const task = (async () => {
      const next = await readBoard();
      if (closed) return;
      if (next === null) { expire(); return; }
      if (!next.length) { clear(); loadedAt = now(); return; }
      if (JSON.stringify(rows) !== JSON.stringify(next)) { rows = next; cursor = 0; generation++; }
      loadedAt = now();
      const retained = new Set(rows.map(row => row.avatar).filter(Boolean));
      for (const url of avatars.keys()) if (!retained.has(url)) avatars.delete(url);
    })();
    refreshTask = task;
    const settled = () => { if (refreshTask === task) refreshTask = null; };
    void task.then(settled, settled);
    return task;
  }

  async function imageFor(url) {
    if (!url || closed) return null;
    const cached = avatars.get(url);
    // A content-addressed IPFS thumbnail cannot change at the same URL. Keep a
    // successful image while its donor is in the bounded Top 5; retry failures.
    if (cached && (cached.image || fresh(cached.at, REFRESH_MS))) return cached.image;
    if (avatarTasks.has(url)) return avatarTasks.get(url);
    const task = (async () => {
      let image = null;
      try {
        const value = await Promise.race([Promise.resolve().then(() => avatarLoader(url)), closedSignal.then(() => null)]);
        if (Buffer.isBuffer(value) && value.length === IMAGE_BYTES) image = Buffer.from(value);
      } catch { /* Its built-in coin is the board's fallback. */ }
      if (!closed && rows.some(row => row.avatar === url)) avatars.set(url, { at: now(), image });
      return image;
    })();
    avatarTasks.set(url, task);
    const settled = () => { if (avatarTasks.get(url) === task) avatarTasks.delete(url); };
    void task.then(settled, settled);
    return task;
  }

  function next() {
    if (closed) return Promise.resolve(null);
    if (!nextTask) {
      const task = (async () => {
        if (refreshTask) await refreshTask;
        else if (!fresh(attemptedAt, REFRESH_MS)) await refresh();
        if (closed) return null;
        expire(); if (!rows.length) return null;
        const epoch = generation, row = rows[cursor++ % rows.length];
        const image = await imageFor(row.avatar);
        if (closed || generation !== epoch) return null;
        expire(); if (generation !== epoch) return null;
        const card = { nick: row.nick, amount: row.amount, rank: row.rank, image };
        const id = createHash("sha256").update(JSON.stringify([card.rank, card.nick, card.amount])).update(image ?? Buffer.from("no-avatar")).digest("hex").slice(0, 24);
        return { id, ...card };
      })();
      nextTask = task;
      const settled = () => { if (nextTask === task) nextTask = null; };
      void task.then(settled, settled);
    }
    return nextTask.then(copyCard);
  }

  return { next, refresh, close() {
    if (closed) return;
    closed = true; generation++; activeRead?.(); finishClose();
    rows = []; cursor = 0; avatars.clear(); avatarTasks.clear();
  } };
}
