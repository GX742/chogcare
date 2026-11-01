import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { renderMediaMtxConfig } from "../ops/stream/mediamtx-config.mjs";
import { renderServerMediaLocation } from "../ops/relay/nginx-config.mjs";
import { readRegularFileSync } from "../server/regular-file.mjs";

const exec = promisify(execFile);
const work = resolve(import.meta.dirname, "../work/server-owned-delivery");
const binary = join(work, "mediamtx-v1.21.3/mediamtx");
const ffmpeg = existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : "/opt/owncast/ffmpeg";
const required = process.env.CHOGCARE_STREAM_INTEGRATION === "1";
// Extracted only after checking the official v1.21.3 Linux amd64 archive against
// checksums.sha256 and both GitHub release API asset digests. No test downloads.
const verifiedBinarySha256 = "bfa372a169751bbf6da2ebddcbcd2f7d3ab3dca3cc553022162eda36fe03e73d";
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function ownedProcess(executable, args, cwd) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MTX_"))), GOMEMLIMIT: "112MiB" };
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let result = null, output = "";
  const capture = chunk => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const ended = new Promise(resolve => {
    child.once("error", () => { result = { spawnFailed: true }; resolve(result); });
    child.once("exit", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  return {
    child, ended,
    get result() { return result; },
    get authRejected() { return /auth|unauthorized|permission|denied/i.test(output); },
    get parserError() { return /(?:unknown field|invalid|error)/i.test(output); },
    async stop() {
      if (!result && child.pid) child.kill("SIGINT");
      await within(ended, 2000);
      if (!result && child.pid) { child.kill("SIGKILL"); await ended; }
    },
  };
}

async function portLease() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  return { port: listener.address().port, close: () => new Promise(resolve => listener.close(resolve)) };
}

async function waitUntil(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await pause(150); } while (Date.now() < deadline);
  assert.fail(description);
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(300); socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false)); socket.once("timeout", () => finish(false));
  });
}

async function listenersOwnedBy(pid) {
  const inodes = new Set();
  for (const descriptor of await readdir(`/proc/${pid}/fd`)) {
    try { const match = (await readlink(`/proc/${pid}/fd/${descriptor}`)).match(/^socket:\[(\d+)\]$/); if (match) inodes.add(match[1]); } catch { /* A fixture connection closed. */ }
  }
  const listeners = [], udp = [];
  for (const table of ["tcp", "tcp6", "udp", "udp6"]) {
    for (const line of (await readFile(`/proc/net/${table}`, "utf8")).trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (!inodes.has(fields[9])) continue;
      const [address, port] = fields[1].split(":");
      if (table.startsWith("udp")) udp.push(parseInt(port, 16));
      else if (fields[3] === "0A") listeners.push({ address, port: parseInt(port, 16) });
    }
  }
  return { listeners, udp };
}

test("verified MediaMTX parses the production renderer and serves authenticated synthetic LL-HLS", {
  skip: !required && (process.platform !== "linux" || !existsSync(binary) || !existsSync(ffmpeg) || !existsSync("/usr/sbin/nginx")) ? "Set CHOGCARE_STREAM_INTEGRATION=1 after preparing the verified binary in work/server-owned-delivery and installing ffmpeg/nginx" : false,
  timeout: 90_000,
}, async t => {
  assert.equal(process.platform, "linux", "This fixture verifies Linux process-owned listeners");
  assert.ok(existsSync(binary) && existsSync(ffmpeg), "Explicit integration runs require the fixed verified MediaMTX and ffmpeg locations");
  assert.ok(existsSync("/usr/sbin/nginx"), "Explicit integration runs also require the fixed system nginx executable");
  // The shared reader opens once, fstats/reads that descriptor with a byte cap,
  // and rejects replacements or changes. Never execute the mutable source path.
  const binaryBytes = readRegularFileSync(binary, 64 * 1024 * 1024);
  assert.equal(createHash("sha256").update(binaryBytes).digest("hex"), verifiedBinarySha256, "Refuse an unverified executable");

  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, "fixture-"));
  const children = [], leases = [];
  t.after(async () => {
    await Promise.all(children.map(child => child.stop()));
    await Promise.all(leases.map(lease => lease.close().catch(() => {})));
    const inside = relative(work, directory);
    assert.ok(inside && !inside.startsWith("..") && !inside.startsWith("/"));
    await rm(directory, { recursive: true, force: true });
  });
  const fixtureBinary = join(directory, "mediamtx");
  await writeFile(fixtureBinary, binaryBytes, { flag: "wx", mode: 0o500 });
  const version = await exec(fixtureBinary, ["--version"], { timeout: 3000 });
  assert.match(version.stdout, /v1\.21\.3\b/);
  const [ingest, hls] = await Promise.all([portLease(), portLease()]);
  leases.push(ingest, hls);
  const certificate = join(directory, "fixture.crt"), key = join(directory, "fixture.key");
  await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", key, "-out", certificate], { timeout: 5000 });
  const password = "integration-fixture-only", readToken = createHash("sha256").update("integration-reader-fixture-only").digest("base64url");
  // Independently calculated synthetic fixture vector for the renderer's
  // MediaMTX SHA-256 credential format, not a real stored password or KDF.
  const publisherPasswordHash = "sha256:u2h2Qxcv6A6KdM+vggkTTRMApEyIaDEFWwO9WdIp138=";
  const configuration = renderMediaMtxConfig({
    publisherPasswordHash,
    hlsReadToken: readToken, rtmpsPort: ingest.port, hlsPort: hls.port,
    rtmpsBindAddress: "127.0.0.1", tlsCertificatePath: certificate, tlsKeyPath: key,
  });
  const configFile = join(directory, "mediamtx.json");
  await writeFile(configFile, configuration, { flag: "wx", mode: 0o600 });
  await Promise.all(leases.splice(0).map(lease => lease.close()));
  const server = ownedProcess(fixtureBinary, [configFile], directory); children.push(server);
  await waitUntil(async () => {
    assert.equal(server.result, null, "MediaMTX rejected the generated configuration or exited");
    return await listening(ingest.port) && await listening(hls.port);
  }, "The real MediaMTX parser must start both fixture listeners");

  await t.test("only loopback RTMPS and HLS listeners are enabled", async () => {
    const sockets = await listenersOwnedBy(server.child.pid);
    assert.deepEqual(sockets.listeners.map(value => value.port).sort((a, b) => a - b), [ingest.port, hls.port].sort((a, b) => a - b));
    assert.ok(sockets.listeners.every(value => value.address === "0100007F"));
    assert.deepEqual(sockets.udp, [], "RTSP, SRT, WebRTC, MoQ and discovery UDP listeners must remain disabled");
    const configured = JSON.parse(configuration);
    assert.equal(configured.rtmpEncryption, "strict");
    assert.deepEqual(configured.authInternalUsers[0].permissions, [{ action: "publish", path: "station" }]);
    assert.deepEqual(configured.authInternalUsers[1].permissions, [{ action: "read", path: "station" }]);
  });

  function publisher({ pass = password, path = "station", anonymous = false, ingestPort = ingest.port } = {}) {
    const query = anonymous ? "" : `?user=publisher&pass=${encodeURIComponent(pass)}`;
    const child = ownedProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=10", "-re", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "1", "-filter_threads", "1", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-tls_verify", "1", "-ca_file", certificate, "-f", "flv", "-flvflags", "no_duration_filesize", `rtmps://127.0.0.1:${ingestPort}/${path}${query}`], directory);
    children.push(child); return child;
  }

  await t.test("TLS publication rejects wrong passwords, anonymous writes and other paths", async () => {
    for (const options of [{ pass: "incorrect-fixture-password" }, { anonymous: true }, { path: "unconfigured" }]) {
      const invalid = publisher(options);
      const outcome = await within(invalid.ended, 7000);
      assert.ok(outcome, "An unauthorized fixture publisher must be rejected within a bounded deadline");
      assert.equal(outcome.spawnFailed, undefined, "Authentication tests must execute the real publisher");
      assert.notEqual(outcome.code, 0, "The unauthorized publish must not succeed");
      assert.equal(server.result, null, "Rejecting a publisher must not crash the server");
    }
  });

  let validPublisher = publisher();
  const origin = `http://127.0.0.1:${hls.port}`;
  async function request(path, token = readToken, maximum = 64 * 1024) {
    const response = await fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(4000), headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= maximum, "Fixture HTTP response exceeded its byte bound"); chunks.push(chunk); }
    return { response, body: Buffer.concat(chunks) };
  }
  let master, media, mediaPath, audioPath;
  await waitUntil(async () => {
    assert.equal(validPublisher.result, null, "The valid synthetic publisher must remain connected");
    master = await request("/station/index.m3u8");
    return master.response.status === 200;
  }, "Correct dummy publisher credentials must produce a readable stream", 15_000);

  await t.test("loopback CDN reader gets stable relative playlists without session redirects or credentials", async () => {
    assert.equal(master.response.status, 200);
    assert.equal(master.response.headers.get("location"), null);
    assert.equal(master.response.headers.get("set-cookie"), null);
    const body = master.body.toString(); assert.match(body, /^#EXTM3U/);
    const variants = body.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
    assert.equal(variants.length, 1);
    assert.match(variants[0], /^[A-Za-z0-9_-]+\.m3u8$/);
    mediaPath = "/station/" + variants[0]; media = await request(mediaPath);
    const audioName = body.match(/^#EXT-X-MEDIA:TYPE=AUDIO,.*?URI="([A-Za-z0-9_-]+\.m3u8)"/m)?.[1];
    assert.ok(audioName, "The real synthetic AAC track must have its own rendition");
    assert.match(body, /CODECS="[^"]*mp4a\.40\.2/);
    audioPath = "/station/" + audioName;
    assert.equal((await request(audioPath)).response.status, 200);
    assert.equal(media.response.status, 200);
    assert.equal(media.response.headers.get("set-cookie"), null);
    assert.doesNotMatch(body + media.body, /cookieCheck|session=|integration-fixture-only|Bearer|https?:\/\//);
    const direct = await request("/station/index.m3u8", null);
    assert.equal(direct.response.status, 302, "Without the proxy-only token, MediaMTX must retain its separate viewer session flow");
    const wrong = await request(mediaPath, "invalid-fixture-reader-token");
    assert.equal(wrong.response.status, 401);
  });

  await t.test("one-second synthetic GOP produces one-second segments and bounded subsecond playable fMP4 parts", async () => {
    const playlist = media.body.toString();
    assert.match(playlist, /^#EXT-X-TARGETDURATION:[12]\s*$/m, "The shared target may round the AAC segment above one second");
    const segments = [...playlist.matchAll(/^#EXTINF:([0-9.]+),/gm)].map(match => Number(match[1]));
    const parts = [...playlist.matchAll(/^#EXT-X-PART:DURATION=([0-9.]+),URI="([^"]+)"/gm)];
    assert.ok(segments.length > 0 && segments.every(value => Math.abs(value - 1) < 0.02));
    // AAC/video sample boundaries can quantize a 200ms minimum upward and
    // leave a shorter final part at the GOP boundary. Test actual bounded
    // subsecond parts instead of assuming every part is exactly 200ms.
    assert.ok(parts.length >= 2 && parts.every(match => Number(match[1]) > 0 && Number(match[1]) <= 0.4));
    const target = playlist.match(/^#EXT-X-PART-INF:PART-TARGET=([0-9.]+)/m);
    assert.ok(target && Number(target[1]) >= 0.18 && Number(target[1]) <= 0.4);
    const map = playlist.match(/^#EXT-X-MAP:URI="([^"]+)"/m);
    const fetchMedia = async uri => {
      assert.match(uri, /^[A-Za-z0-9_.-]+\.mp4$/);
      const result = await request("/station/" + uri, readToken, 2 * 1024 * 1024);
      assert.equal(result.response.status, 200); return result.body;
    };
    assert.ok(map);
    const init = await fetchMedia(map[1]); assert.ok(init.includes(Buffer.from("ftyp")) && init.includes(Buffer.from("moov")));
    const part = await fetchMedia(parts.at(-1)[2]); assert.ok(part.includes(Buffer.from("moof")) && part.includes(Buffer.from("mdat")));
  });

  await t.test("media sequence and partial media advance with bounded process memory", async () => {
    const first = media.body.toString(), firstSequence = Number(first.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
    const firstPart = [...first.matchAll(/^#EXT-X-PART:.*URI="([^"]+)"/gm)].at(-1)?.[1];
    assert.ok(Number.isSafeInteger(firstSequence) && firstPart);
    await waitUntil(async () => {
      const next = await request(mediaPath); if (next.response.status !== 200) return false;
      const body = next.body.toString(), sequence = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
      const part = [...body.matchAll(/^#EXT-X-PART:.*URI="([^"]+)"/gm)].at(-1)?.[1];
      return sequence > firstSequence && part && part !== firstPart;
    }, "LL-HLS sequence and parts must keep advancing", 10_000);
    const status = await readFile(`/proc/${server.child.pid}/status`, "utf8"), rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]);
    assert.ok(Number.isFinite(rssKiB) && rssKiB > 0 && rssKiB < 160 * 1024, "The isolated low-resolution stream must remain below the service's 160MiB memory limit");
    assert.equal(validPublisher.result, null); assert.equal(server.result, null);
  });

  await t.test("LL-HLS reload parameters work without viewer sessions", async () => {
    const current = await request(mediaPath), body = current.body.toString();
    const sequence = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
    assert.ok(Number.isSafeInteger(sequence));
    // MediaMTX starts LL-HLS with required gap placeholders. Request the last
    // completed real segment, rather than a startup gap that correctly gets400.
    const completed = [...body.matchAll(/^#EXTINF:/gm)].length;
    assert.ok(completed > 0);
    const reload = await request(`${mediaPath}?_HLS_msn=${sequence + completed - 1}&_HLS_part=0&_HLS_skip=YES`);
    assert.equal(reload.response.status, 200);
    assert.match(reload.body.toString(), /^#EXTM3U/);
    assert.equal(reload.response.headers.get("location"), null);
    assert.equal(reload.response.headers.get("set-cookie"), null);
  });

  await t.test("the real nginx media location projects complete video/audio playlists without changing media or viewer isolation", async () => {
    // Observe only this fixture's headers, then forward to the real MediaMTX
    // listener. This checks nginx's parsed behavior rather than matching text.
    const observed = [];
    const witness = Buffer.from('#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.5\n#EXT-X-PART-INF:PART-TARGET=0.2\n#EXT-X-PART:DURATION=0.2,URI="part.mp4"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.mp4"\n#EXT-X-RENDITION-REPORT:URI="audio.m3u8",LAST-MSN=9,LAST-PART=2\n#EXT-X-PART-INFORMATION:unknown-prefix-must-survive\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n#EXTINF:1,\nsegment.mp4\n');
    const tap = createHttpServer((incoming, outgoing) => {
      const observation = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: null };
      observed.push(observation);
      if (["/station/filter-witness.m3u8", "/station/filter-witness-alt.m3u8"].includes(incoming.url)) {
        // The pinned muxer currently omits RENDITION-REPORT. A fixed syntax
        // witness exercises that fifth substitution in real nginx as well.
        observation.body = witness;
        outgoing.writeHead(200, { "Content-Type": incoming.url.includes("-alt") ? "application/x-mpegurl" : "application/vnd.apple.mpegurl", "Content-Length": witness.length });
        outgoing.end(witness); return;
      }
      const upstream = httpRequest({ host: "127.0.0.1", port: hls.port, path: incoming.url, method: incoming.method, headers: incoming.headers, timeout: 4000 }, response => {
        const chunks = []; let size = 0;
        response.on("data", chunk => { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); else upstream.destroy(); });
        response.on("end", () => { observation.body = Buffer.concat(chunks); });
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    });
    await new Promise(resolve => tap.listen(0, "127.0.0.1", resolve));
    t.after(async () => { tap.closeAllConnections(); await new Promise(resolve => tap.close(resolve)); });
    const proxy = await portLease();
    leases.push(proxy);
    const nginxConfig = join(directory, "nginx.conf");
    await writeFile(nginxConfig, `pid ${join(directory, "nginx.pid")};\nerror_log stderr error;\nevents { worker_connections 32; }\nhttp { access_log off; server { listen 127.0.0.1:${proxy.port};\n${renderServerMediaLocation({ hlsPort: tap.address().port, hlsReadToken: readToken })}\nlocation / { return 404; }\n} }\n`, { mode: 0o600 });
    await exec("/usr/sbin/nginx", ["-p", directory + "/", "-c", nginxConfig, "-t"], { timeout: 5000 });
    await proxy.close();
    const nginx = ownedProcess("/usr/sbin/nginx", ["-p", directory + "/", "-c", nginxConfig, "-g", "daemon off; master_process off;"], directory);
    children.push(nginx);
    await waitUntil(async () => { assert.equal(nginx.result, null); return listening(proxy.port); }, "The isolated generated nginx location must start");
    const headers = { Authorization: "Bearer viewer-fixture-value", Origin: "https://viewer.invalid", Cookie: "viewer-fixture=1", "Idempotency-Key": "fixture-only", "X-Forwarded-For": "198.51.100.1", "X-Real-IP": "198.51.100.1", Forwarded: "for=198.51.100.1", "X-Forwarded-Host": "viewer.invalid", "X-Forwarded-Port": "12345", "Accept-Encoding": "gzip, deflate, br" };
    const throughProxy = async (path, method = "GET", extraHeaders = {}) => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method, headers: { ...headers, ...extraHeaders }, redirect: "manual", signal: AbortSignal.timeout(4000) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body || []) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024); chunks.push(chunk); }
      return { response, body: Buffer.concat(chunks) };
    };
    const proxied = await throughProxy("/live/station/index.m3u8");
    assert.equal(proxied.response.status, 200);
    assert.equal(proxied.response.headers.get("location"), null);
    assert.equal(proxied.response.headers.get("set-cookie"), null);
    assert.equal(proxied.response.headers.get("cache-control"), "no-store");
    assert.equal(observed.at(-1).url, "/station/index.m3u8");
    assert.equal(observed.at(-1).headers.authorization, `Bearer ${readToken}`);
    assert.equal(observed.at(-1).headers["accept-encoding"], undefined, "Playlist substitution must receive identity bytes");
    for (const header of ["origin", "cookie", "idempotency-key", "x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-port"]) assert.equal(observed.at(-1).headers[header], undefined, header);
    const head = await throughProxy("/live/station/index.m3u8", "HEAD");
    assert.equal(head.response.status, 200); assert.equal(head.body.length, 0);
    assert.equal(observed.at(-1).method, "GET");
    const llTags = ["SERVER-CONTROL", "PART-INF", "PART", "PRELOAD-HINT", "RENDITION-REPORT"];
    const witnessed = new Set(); let partUri;
    for (const path of [mediaPath, audioPath]) {
      const playlist = await throughProxy(path.replace("/station/", "/live/station/"));
      assert.equal(playlist.response.status, 200);
      const text = playlist.body.toString(), original = observed.at(-1).body.toString();
      assert.match(text, /^#EXT-X-VERSION:10$/m);
      assert.match(text, /^#EXT-X-MAP:/m); assert.match(text, /^#EXT-X-PROGRAM-DATE-TIME:/m); assert.match(text, /^#EXTINF:/m);
      for (const tag of llTags) {
        assert.doesNotMatch(text, new RegExp(`^#EXT-X-${tag}:`, "m"));
        if (original.includes(`#EXT-X-${tag}:`)) {
          witnessed.add(tag); assert.ok(text.includes(`#CHOGCARE-${tag}:`));
        }
      }
      const retained = value => value.split(/\r?\n/).filter(line => !llTags.some(tag => line.startsWith(`#EXT-X-${tag}:`) || line.startsWith(`#CHOGCARE-${tag}:`)));
      assert.deepEqual(retained(text), retained(original), "Complete media, maps, version, timestamps and rendition metadata must be byte-preserved");
      const sequence = Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
      const complete = [...text.matchAll(/^#EXTINF:/gm)].length;
      const query = `?_HLS_msn=${sequence + complete + 100}&_HLS_part=0&_HLS_skip=YES`;
      const reload = await throughProxy(path.replace("/station/", "/live/station/") + query);
      assert.equal(reload.response.status, 200, "A future blocking/delta request must become a normal full-playlist fetch");
      assert.equal(observed.at(-1).url, path, "No viewer LL-HLS delivery directive may reach the origin");
      assert.doesNotMatch(reload.body.toString(), /^#EXT-X-SKIP:/m);
      assert.equal([...reload.body.toString().matchAll(/^#EXTINF:/gm)].length, [...observed.at(-1).body.toString().matchAll(/^#EXTINF:/gm)].length);
      const map = text.match(/^#EXT-X-MAP:URI="([A-Za-z0-9_-]+\.mp4)"/m)?.[1];
      const segment = text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).at(-1);
      for (const name of [map, segment]) {
        assert.match(name, /^[A-Za-z0-9_-]{1,160}\.mp4$/);
        const mp4 = await throughProxy("/live/station/" + name, "GET", { Range: "bytes=0-1" });
        assert.equal(mp4.response.status, 200, "The existing upstream's full-200 Range behavior must be preserved");
        assert.equal(observed.at(-1).headers.range, "bytes=0-1");
        assert.deepEqual(mp4.body, observed.at(-1).body, "A playlist-only filter must never modify MP4 init/media bytes");
      }
      partUri ??= [...original.matchAll(/^#EXT-X-PART:.*URI="([^"]+)"/gm)].at(-1)?.[1];
    }
    for (const name of ["filter-witness.m3u8", "filter-witness-alt.m3u8"]) {
      const result = await throughProxy("/live/station/" + name);
      assert.equal(result.response.status, 200);
      const text = result.body.toString();
      for (const tag of llTags) {
        assert.doesNotMatch(text, new RegExp(`^#EXT-X-${tag}:`, "m"));
        assert.ok(text.includes(`#CHOGCARE-${tag}:`)); witnessed.add(tag);
      }
      assert.match(text, /^#EXT-X-PART-INFORMATION:unknown-prefix-must-survive$/m, "Only the exact tag-plus-colon prefixes may change");
      const preserved = value => value.split(/\r?\n/).filter(line => !llTags.some(tag => line.startsWith(`#EXT-X-${tag}:`) || line.startsWith(`#CHOGCARE-${tag}:`)));
      assert.deepEqual(preserved(text), preserved(witness.toString()));
    }
    assert.deepEqual([...witnessed].sort(), [...llTags].sort(), "Real media plus fixed MIME witnesses must exercise all five substitutions in nginx");
    assert.match(partUri, /^[A-Za-z0-9_-]{1,160}\.mp4$/);
    const part = await throughProxy("/live/station/" + partUri);
    assert.equal(part.response.status, 200); assert.ok(part.body.includes(Buffer.from("moof")));
    const forwarded = observed.length;
    for (const path of ["/live", "/live/station", "/live/station/index.html", "/live/station/sub/index.m3u8", "/live/unconfigured/index.m3u8"]) assert.equal((await throughProxy(path)).response.status, 404);
    assert.equal((await throughProxy("/live/station/index.m3u8", "POST")).response.status, 403);
    assert.equal(observed.length, forwarded, "Rejected methods and paths must never reach the media origin");
  });

  await t.test("stopping and reconnecting only the fixture publisher restores real media", async () => {
    await validPublisher.stop();
    await waitUntil(async () => (await request(mediaPath)).response.status !== 200,
      "Stopped publication must not keep serving an apparently live stale playlist", 8000);
    assert.equal(server.result, null);
    validPublisher = publisher();
    let previousPart = null;
    await waitUntil(async () => {
      assert.equal(validPublisher.result, null, "The reconnected fixture publisher must remain connected");
      const fresh = await request("/station/index.m3u8");
      if (fresh.response.status !== 200) return false;
      const current = await request(mediaPath);
      if (current.response.status !== 200) return false;
      const part = [...current.body.toString().matchAll(/^#EXT-X-PART:.*URI="([^"]+)"/gm)].at(-1)?.[1];
      const advanced = part && previousPart && part !== previousPart;
      previousPart = part;
      return advanced;
    }, "A fresh authenticated publisher must restore advancing LL-HLS parts", 15_000);
  });

  await t.test("a delayed TLS publisher outlives the old startup deadline and produces real media", async () => {
    // MediaMTX starts one read deadline before TLS/RTMP setup and retains it
    // through its two-second media discovery. An opaque TCP relay preserves
    // certificate verification while making this startup delay deterministic.
    for (const legacy of [true, false]) {
      const [delayedIngest, delayedHls] = await Promise.all([portLease(), portLease()]);
      leases.push(delayedIngest, delayedHls);
      const delayedConfig = JSON.parse(configuration);
      delayedConfig.rtmpsAddress = `127.0.0.1:${delayedIngest.port}`;
      delayedConfig.hlsAddress = `127.0.0.1:${delayedHls.port}`;
      if (legacy) delayedConfig.readTimeout = "5s";
      const delayedFile = join(directory, legacy ? "startup-legacy.json" : "startup-current.json");
      await writeFile(delayedFile, JSON.stringify(delayedConfig), { flag: "wx", mode: 0o600 });
      await Promise.all([delayedIngest.close(), delayedHls.close()]);
      const delayedServer = ownedProcess(fixtureBinary, [delayedFile], directory);
      children.push(delayedServer);
      await waitUntil(async () => {
        assert.equal(delayedServer.result, null);
        return listening(delayedIngest.port);
      }, "The isolated delayed-start origin must listen");

      const sockets = new Set(), timers = new Set();
      const tunnel = createServer(client => {
        const upstream = connect({ host: "127.0.0.1", port: delayedIngest.port });
        sockets.add(client); sockets.add(upstream);
        client.pause();
        const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
        client.on("error", close); upstream.on("error", close);
        client.on("close", close); upstream.on("close", close);
        upstream.once("connect", () => {
          upstream.pipe(client);
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!client.destroyed && !upstream.destroyed) { client.pipe(upstream); client.resume(); }
          }, 3500);
          timers.add(timer);
        });
      });
      await new Promise(resolve => tunnel.listen(0, "127.0.0.1", resolve));
      let delayedPublisher;
      try {
        delayedPublisher = publisher({ ingestPort: tunnel.address().port });
        if (legacy) {
          const ended = await within(delayedPublisher.ended, 9000);
          assert.ok(ended, "The old five-second budget must close during delayed setup plus media discovery");
          assert.equal(ended.spawnFailed, undefined);
          assert.notEqual(ended.code, 0);
        } else {
          let playlist;
          await waitUntil(async () => {
            assert.equal(delayedPublisher.result, null, "The current budget must keep the same delayed publisher connected");
            const response = await fetch(`http://127.0.0.1:${delayedHls.port}/station/index.m3u8`, {
              headers: { Authorization: `Bearer ${readToken}` }, signal: AbortSignal.timeout(2000),
            });
            playlist = await response.text();
            assert.ok(playlist.length < 64 * 1024);
            return response.status === 200;
          }, "The renderer must admit the delayed publisher and produce an actual HLS playlist", 14_000);
          assert.match(playlist, /^#EXTM3U/);
          const variant = playlist.split(/\r?\n/).find(line => line && !line.startsWith("#"));
          assert.match(variant, /^[A-Za-z0-9_-]+\.m3u8$/);
          const response = await fetch(`http://127.0.0.1:${delayedHls.port}/station/${variant}`, {
            headers: { Authorization: `Bearer ${readToken}` }, signal: AbortSignal.timeout(2000),
          });
          assert.equal(response.status, 200);
          const media = await response.text();
          assert.ok(media.length < 64 * 1024);
          assert.match(media, /^#EXT-X-PART:.*URI="[A-Za-z0-9_-]+\.mp4"/m);
        }
        assert.equal(delayedServer.result, null);
      } finally {
        await delayedPublisher?.stop();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => tunnel.close(resolve));
        await delayedServer.stop();
      }
    }
  });
});
