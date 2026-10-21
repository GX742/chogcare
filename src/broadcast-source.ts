// Public playback uses the site's HLS rewrite, so phones never need to resolve
// or connect directly to the relay's split-DNS hostname. Validate configuration
// first: an unexpected URL must never become a proxy destination or local probe.
export const publicBroadcastOrigin = "https://45.38.60.159";
// Existing deployment settings may still name the previous public relay.
// Recognize only that exact origin, then route it through the replacement.
const legacyBroadcastOrigin = "https://chogcare-stream.tail1f833b.ts.net";
const localBroadcastOrigins = ["http://127.0.0.1:8082", "http://localhost:8082"];
export function broadcastPreviewUrl(streamUrl: string, applicationOrigin: string): string | null {
  try {
    const stream = new URL(streamUrl), application = new URL(applicationOrigin);
    if (!["http:", "https:"].includes(stream.protocol) || !["http:", "https:"].includes(application.protocol) ||
      application.username || application.password || stream.username || stream.password || stream.search || stream.hash ||
      ![publicBroadcastOrigin, application.origin].includes(stream.origin) ||
      !["/hls/stream.m3u8", "/hls/mobile/stream.m3u8"].includes(stream.pathname)) return null;
    stream.pathname = "/hls/mobile/preview.jpg";
    return stream.href;
  } catch { return null; }
}
export function broadcastStreamUrl(configuredUrl: unknown, applicationOrigin: string, mobile = false): string | null {
  const value = configuredUrl === undefined || configuredUrl === "" ? publicBroadcastOrigin : configuredUrl;
  if (typeof value !== "string" || /\s/.test(value) || value.length > 512) return null;
  try {
    let url = new URL(value);
    const application = new URL(applicationOrigin);
    if (url.username || url.password || application.username || application.password) return null;
    if (url.origin === legacyBroadcastOrigin) url = new URL(publicBroadcastOrigin);
    const localApplication = ["http:", "https:"].includes(application.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(application.hostname);
    if (url.origin !== publicBroadcastOrigin && !(localApplication && localBroadcastOrigins.includes(url.origin))) return null;
    const path = mobile && url.origin === publicBroadcastOrigin ? "/hls/mobile/stream.m3u8" : "/hls/stream.m3u8";
    if (!localApplication) return application.protocol === "https:" ? new URL(path, application.origin).href : null;
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}
