// MediaMTX v1.21.3 accepts JSON as YAML. Returning JSON keeps all credential
// and filesystem values data, never configuration syntax or executable hooks.
export const MEDIA_MTX_VERSION = "1.21.3";
export const MEDIA_MTX_LINUX_AMD64_SHA256 = "0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635";

function exactMatch(value, pattern) {
  return typeof value === "string" && value.match(pattern)?.[0] === value;
}

export function streamPathSegment(value = "station") {
  if (!exactMatch(value, /^[a-z][a-z0-9_-]{0,63}$/) || ["all", "all_others"].includes(value)) throw new Error("A bounded explicit lowercase stream path is required.");
  return value;
}

export function streamListenerPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("A non-privileged TCP port is required.");
  return value;
}

export function streamReadToken(value) {
  if (!exactMatch(value, /^[A-Za-z0-9_-]{43}$/) ||
      Buffer.from(value, "base64url").length !== 32 || Buffer.from(value, "base64url").toString("base64url") !== value) {
    throw new Error("A canonical 256-bit base64url HLS reader token is required.");
  }
  return value;
}

function credentialPath(value) {
  if (!exactMatch(value, /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/) ||
      value.split("/").some(segment => segment === "." || segment === "..")) {
    throw new Error("An absolute Linux credential file path without traversal is required.");
  }
  return value;
}

/** A single TLS publisher and a loopback-only HLS reader; no default users. */
export function renderMediaMtxConfig({
  publisherPasswordHash,
  hlsReadToken,
  publisherUser = "publisher",
  streamPath = "station",
  rtmpsPort = 1936,
  hlsPort = 8888,
  rtmpsBindAddress = "0.0.0.0",
  tlsCertificatePath = "/run/credentials/chogcare-stream.service/tls.crt",
  tlsKeyPath = "/run/credentials/chogcare-stream.service/tls.key",
} = {}) {
  const path = streamPathSegment(streamPath);
  const ingestPort = streamListenerPort(rtmpsPort);
  const readPort = streamListenerPort(hlsPort);
  if (ingestPort === readPort) throw new Error("Publisher and HLS listeners need different ports.");
  if (!["0.0.0.0", "127.0.0.1"].includes(rtmpsBindAddress)) throw new Error("An explicit public or loopback IPv4 bind address is required.");
  if (!exactMatch(publisherUser, /^[a-z][a-z0-9_-]{0,63}$/) || publisherUser === "any") throw new Error("A dedicated publisher username is required.");
  const digest = typeof publisherPasswordHash === "string" ? publisherPasswordHash.slice(7) : "";
  if (!exactMatch(publisherPasswordHash, /^sha256:[A-Za-z0-9+/]{43}=$/) ||
      Buffer.from(digest, "base64").length !== 32 || Buffer.from(digest, "base64").toString("base64") !== digest) {
    throw new Error("A canonical SHA-256 base64 publisher password hash is required.");
  }

  return `${JSON.stringify({
    logLevel: "warn",
    logDestinations: ["stdout"],
    dumpPackets: false,
    readTimeout: "15s",
    writeTimeout: "5s",
    writeQueueSize: 64,
    authMethod: "internal",
    authInternalUsers: [
      { user: publisherUser, pass: publisherPasswordHash, ips: [], permissions: [{ action: "publish", path }] },
      { user: "any", pass: "", ips: ["127.0.0.1/32", "::1/128"], permissions: [{ action: "read", path }] },
    ],
    api: false,
    metrics: false,
    pprof: false,
    playback: false,
    rtsp: false,
    rtmp: true,
    rtmpEncryption: "strict",
    rtmpAddress: "127.0.0.1:1935",
    rtmpsAddress: `${rtmpsBindAddress}:${ingestPort}`,
    rtmpServerCert: credentialPath(tlsCertificatePath),
    rtmpServerKey: credentialPath(tlsKeyPath),
    rtmpTrustedProxies: [],
    hls: true,
    hlsAddress: `127.0.0.1:${readPort}`,
    hlsEncryption: false,
    hlsAllowOrigins: [],
    hlsTrustedProxies: [],
    // CDN mode avoids per-viewer cookies, internal-path redirects and session
    // query tokens. The loopback nginx location supplies this separate token.
    hlsCDNSecret: streamReadToken(hlsReadToken),
    hlsAlwaysRemux: true,
    hlsVariant: "lowLatency",
    hlsSegmentCount: 7,
    hlsSegmentDuration: "1s",
    hlsPartDuration: "200ms",
    hlsSegmentMaxSize: "2M",
    hlsDirectory: "",
    webrtc: false,
    srt: false,
    moq: false,
    pathDefaults: { source: "publisher", overridePublisher: false, record: false, alwaysAvailable: false },
    paths: { [path]: {} },
  }, null, 2)}\n`;
}
