import { stationNickname } from "../server/station-events.mjs";

const ID = /^[a-f0-9]{24}$/;
const OFFSET = /^(?:0|[1-9]\d{0,3})$/;
const AMOUNT = /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+|0)(?:\.\d{1,2})?$/;
const ACK_KEYS = new Set(["v", "type", "id", "status", "offset"]);
const IMAGE_BYTES = 8192, PIXELS_PER_CHUNK = 64, IMAGE_PIXELS = 4096;
const MAX_LINE_BYTES = 384, ACK_TIMEOUT_MS = 1200, REMEMBERED_IDS = 64;
const matches = (pattern, value) => typeof value === "string" && value.match(pattern)?.[0] === value;

// This channel has its own ACK type; it can never acknowledge a donation.
export function validStationBoardAck(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== ACK_KEYS.size || Object.keys(value).some(key => !ACK_KEYS.has(key)) ||
        value.v !== 1 || value.type !== "boardack" || !matches(ID, value.id) || !matches(OFFSET, value.offset)) return false;
    const offset = Number(value.offset);
    if (value.status === "ready") return offset === 0;
    if (value.status === "chunk") return offset >= PIXELS_PER_CHUNK && offset <= IMAGE_PIXELS && offset % PIXELS_PER_CHUNK === 0;
    return value.status === "shown" && (offset === 0 || offset === IMAGE_PIXELS);
  } catch { return false; }
}

function checkedCard(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { id, nick, amount, rank, image } = value;
    if (!matches(ID, id) || typeof nick !== "string" || [...nick].length > 24 ||
        Buffer.byteLength(nick, "utf8") > 96 || stationNickname(nick) !== nick ||
        typeof amount !== "string" || amount.length > 110 ||
        !(amount === "<0.01" || matches(AMOUNT, amount) && /[1-9]/.test(amount)) ||
        !Number.isSafeInteger(rank) || rank < 1 || rank > 20 ||
        image !== null && (!Buffer.isBuffer(image) || image.byteLength !== IMAGE_BYTES)) return null;
    return { id, nick, amount, rank, image: image === null ? null : Buffer.from(image) };
  } catch { return null; }
}

function wireLine(command) {
  const line = `${JSON.stringify(command)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Station board command exceeds its wire limit.");
  return line;
}

// Presentation only: no ledger, transaction submission or donation completion.
// The caller must mint a fresh 96-bit ID for EVERY show attempt, including after
// cancellation/reboot. ACKs carry that wire nonce, not a reusable cached card ID.
// Invalid, unsupported or overlapping shows resolve false without queuing work.
export function createStationBoardTransport({ write, canSend = () => true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if ([write, canSend, now, setTimer, clearTimer].some(fn => typeof fn !== "function")) throw new Error("Station board transport callbacks are required.");
  let supported = false, closed = false, generation = 0, active = null;
  const recentIds = new Set();
  const time = () => { const value = now(); if (!Number.isFinite(value)) throw new Error("Invalid station board clock."); return value; };
  const permitted = () => { try { return canSend() === true; } catch { return false; } };
  const current = session => !closed && supported && active === session && generation === session.generation;
  const clear = handle => { try { clearTimer(handle); } catch { /* A stale timer still checks its session and waiter. */ } };
  const settleWait = (session, waiter, result) => {
    if (session.waiting !== waiter) return;
    session.waiting = null; clear(waiter.timer); waiter.resolve(result);
  };
  const finish = (session, result) => {
    if (active !== session) return;
    active = null;
    if (session.waiting) settleWait(session, session.waiting, false);
    session.resolve(result);
  };
  const cancel = () => { if (active) finish(active, false); generation++; };

  async function command(session, value, status, offset) {
    const line = wireLine(value); // Reuse these identical bytes for the sole retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current(session) || !permitted()) return false;
      const acknowledged = await new Promise(resolve => {
        const waiter = { status, offset, deadline: time() + ACK_TIMEOUT_MS, resolve, timer: null };
        session.waiting = waiter;
        waiter.timer = setTimer(() => settleWait(session, waiter, false), ACK_TIMEOUT_MS);
        // The waiter exists before write: an immediate/synchronous ACK is valid.
        if (!current(session) || !permitted()) { finish(session, false); return; }
        try {
          const result = write(line);
          if (result && typeof result.then === "function") Promise.resolve(result).catch(() => finish(session, false));
        } catch { finish(session, false); }
      });
      if (acknowledged) return current(session) && permitted();
    }
    return false;
  }

  async function transfer(session, card) {
    if (!await command(session, { v: 1, type: "board", id: card.id, nick: card.nick, amount: card.amount, rank: String(card.rank), image: card.image !== null }, "ready", 0)) return false;
    if (card.image) {
      for (let offset = 0; offset < IMAGE_PIXELS; offset += PIXELS_PER_CHUNK) {
        const data = card.image.subarray(offset * 2, (offset + PIXELS_PER_CHUNK) * 2).toString("hex");
        if (!await command(session, { v: 1, type: "pixels", id: card.id, offset: String(offset), data }, "chunk", offset + PIXELS_PER_CHUNK)) return false;
      }
    }
    return command(session, { v: 1, type: "boardshow", id: card.id }, "shown", card.image ? IMAGE_PIXELS : 0);
  }

  return {
    setSupported(value) { supported = !closed && value === true; if (!supported) cancel(); },
    receive(message) {
      // These signals preempt presentation, while remaining available to the
      // donation controller. Pings/pongs never resolve a board command.
      if (message?.v === 1 && (message.type === "hello" || message.type === "fault" ||
          message.type === "ack" && matches(ID, message.id) && ["accepted", "done"].includes(message.status))) {
        cancel(); return false;
      }
      if (!validStationBoardAck(message) || !active || !current(active)) return false;
      const waiter = active.waiting;
      if (!waiter || message.id !== active.id || message.status !== waiter.status || Number(message.offset) !== waiter.offset) return false;
      try { if (time() > waiter.deadline) return false; } catch { cancel(); return false; }
      settleWait(active, waiter, true); return true;
    },
    async show(value) {
      if (closed || !supported || active || !permitted()) return false;
      const card = checkedCard(value);
      if (!card || recentIds.has(card.id)) return false;
      try { wireLine({ v: 1, type: "board", id: card.id, nick: card.nick, amount: card.amount, rank: String(card.rank), image: card.image !== null }); time(); }
      catch { return false; }
      recentIds.add(card.id);
      if (recentIds.size > REMEMBERED_IDS) recentIds.delete(recentIds.keys().next().value);
      return new Promise(resolve => {
        const session = { id: card.id, generation: ++generation, waiting: null, resolve };
        active = session;
        void transfer(session, card).then(result => finish(session, result), () => finish(session, false));
      });
    },
    cancel,
    close() { closed = true; supported = false; cancel(); },
    get supported() { return supported && !closed; },
    get busy() { return active !== null; },
  };
}
