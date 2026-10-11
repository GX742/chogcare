import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "chogcare_session";
const WINDOW = 60_000;
const MAX_BUCKETS = 10_000;

export function createHttpAdmission(origin, clock = Date.now) {
  const secret = randomBytes(32), buckets = new Map();
  const sign = value => createHmac("sha256", secret).update(value).digest("base64url");
  function session(req, res, issue = false) {
    const matches = String(req.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    const token = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : "";
    const [id, expiry, signature, extra] = token.split(".");
    if (!extra && /^[a-f0-9]{48}$/.test(id ?? "") && /^\d{13}$/.test(expiry ?? "") && /^[A-Za-z0-9_-]{43}$/.test(signature ?? "")) {
      const expected = sign(`${id}.${expiry}`);
      if (Number(expiry) > clock() && Number(expiry) <= clock() + 86_400_000 && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return id;
    }
    if (!issue) return null;
    const nextId = randomBytes(24).toString("hex"), nextExpiry = clock() + 86_400_000, value = `${nextId}.${nextExpiry}`;
    res.setHeader("Set-Cookie", `${COOKIE}=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/api/payments; Max-Age=86400${new URL(origin).protocol === "https:" ? "; Secure" : ""}`);
    return nextId;
  }
  function consume(key, max) {
    const now = clock();
    for (const [name, bucket] of buckets) if (bucket.reset <= now) buckets.delete(name);
    let bucket = buckets.get(key);
    if (!bucket) {
      // Refuse rather than evicting existing limits under a random-identity flood.
      if (buckets.size >= MAX_BUCKETS) return 60;
      bucket = { count: 0, reset: now + WINDOW }; buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count > max ? Math.max(1, Math.ceil((bucket.reset - now) / 1000)) : 0;
  }
  return {
    session,
    admit(req, kind, sessionId) {
      // X-Forwarded-For/Forwarded are deliberately ignored. Local Vite clients
      // share a peer but not a signed browser session; status has its own budget.
      const peer = req.socket.remoteAddress || "unknown";
      const limits = kind === "create"
        ? [["create:global", 60], [`create:peer:${peer}`, 60], [`create:session:${sessionId ?? peer}`, 8]]
        : [["read:global", 6000], [`read:peer:${peer}`, 3000], ...(sessionId ? [[`read:session:${sessionId}`, 240]] : [[`read:anonymous:${peer}`, 600]])];
      for (const [key, max] of limits) { const wait = consume(key, max); if (wait) return wait; }
      return 0;
    },
  };
}
