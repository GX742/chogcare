// Keep this allowlist aligned with the connect-src/media-src CSP. A public
// deployment must never turn a configured player URL into a localhost probe.
export const publicBroadcastOrigin = "https://chogcare-stream.tail1f833b.ts.net";
const localBroadcastOrigins = ["http://127.0.0.1:8080", "http://localhost:8080"];
export function broadcastStreamUrl(configuredUrl: unknown, applicationOrigin: string): string | null {
  const value = configuredUrl === undefined || configuredUrl === "" ? publicBroadcastOrigin : configuredUrl;
  if (typeof value !== "string" || /\s/.test(value) || value.length > 512) return null;
  try {
    const url = new URL(value), application = new URL(applicationOrigin);
    if (url.username || url.password) return null;
    const localApplication = ["http:", "https:"].includes(application.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(application.hostname);
    if (url.origin !== publicBroadcastOrigin && !(localApplication && localBroadcastOrigins.includes(url.origin))) return null;
    url.pathname = "/hls/stream.m3u8";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}
