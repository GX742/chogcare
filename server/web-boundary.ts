import type { IncomingMessage, ServerResponse } from "node:http";

export function contentSecurityPolicy(developmentNonce?: string): string {
  if (developmentNonce && developmentNonce.match(/^[A-Za-z0-9+/=]{24,64}$/)?.[0] !== developmentNonce) throw new Error("Invalid development CSP nonce.");
  const nonce = developmentNonce ? ` 'nonce-${developmentNonce}'` : "";
  return [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "frame-src https://player.twitch.tv https://stream.chogcare.com http://127.0.0.1:8080 http://localhost:8080",
    `script-src 'self'${nonce}`, "script-src-attr 'none'", `style-src 'self'${nonce}`, "style-src-attr 'none'",
    "img-src 'self' data: https://giveth.mypinata.cloud https://gateway.pinata.cloud https://www.animal-ethics.org https://media-refresh.heifer.org",
    // This local-only boundary supports the existing relay and local Owncast.
    // MSE and the hls.js worker use blob URLs. Never allow arbitrary hosts;
    // the deployed Vercel policy does not include these loopback exceptions.
    "font-src 'self'", `connect-src 'self' https://chogcare-stream.tail1f833b.ts.net http://127.0.0.1:8080 http://localhost:8080${developmentNonce ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
    "form-action 'none'", "worker-src 'self' blob:", "media-src 'self' blob: https://chogcare-stream.tail1f833b.ts.net http://127.0.0.1:8080 http://localhost:8080", "manifest-src 'self'",
  ].join("; ");
}

// Defense in depth for LOCAL development, not a production reverse proxy.
// Runs before Vite's static, raw-import, public and /@fs handlers.
export function privateWebPath(rawUrl: string): boolean {
  let path = rawUrl.split("?")[0].split("#")[0];
  try {
    for (let i = 0; i < 6; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { return true; }
  if (path.includes("%") || /[\x00-\x1f]/.test(path)) return true;
  path = path.replaceAll("\\", "/").toLowerCase();
  const segments = path.split("/").map(part => part.replace(/[ .]+$/g, ""));
  return segments.some(part =>
    ["work", "admin", "server", "scripts", "test", "contracts", "artifacts", "docs", ".git", ".codex", ".agents", ".aws", ".ssh"].includes(part) ||
    part === ".env" || part.startsWith(".env.") || part === ".npmrc" || part === ".yarnrc.yml" ||
    /\.(?:(?:sqlite3?|db)(?:-(?:wal|shm|journal))?|pem|key|pfx|p12|crt|cer|der)$/.test(part) || part === "vault.json" ||
    // Windows alternate streams are never valid frontend assets.
    (part.includes(":") && !/^[a-z]:$/.test(part)));
}

export function webBoundary(req: IncomingMessage, res: ServerResponse, next: () => void, developmentNonce?: string) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(developmentNonce));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // This deployment is deliberately loopback-only. Do not turn dev/preview into
  // an internet-facing payment server by adding a wildcard Host exception.
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host || "")) {
    res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Local application host required.");
    return;
  }
  if (privateWebPath(req.url || "/")) {
    res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Private application files are not served.");
    return;
  }
  next();
}
