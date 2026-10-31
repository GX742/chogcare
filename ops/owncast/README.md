ChogCare serves the public HLS paths and the existing payment API through the
loopback nginx proxy on port 8090. Tailscale Funnel exposes this proxy; Vercel's
`/hls/:path*` rewrite keeps browser playback on the site's own origin. Playlists
are not cached by the Vercel rewrite. Completed successful mobile TS segments
use a 60-second public cache to reduce repeat upstream transfers after cache fill.
Preview frames, errors and payment responses remain uncached. Segment numbers
use microseconds since epoch so encoder restarts do not reuse cached URLs.

The source stream remains in Owncast. `chogcare-mobile.service` reads that local
stream and produces a 360 × 640, 15 fps H.264 video rendition with a 160 kbps
video target and a 220 kbps cap. This leaves headroom for retransmits on the
lossy public uplink. The website always plays muted, so this rendition has no audio
scheduler or additional AAC encoding queue. Every public website player loads
this rendition directly. The gateway's public master also advertises only this
rendition, covering existing frontend deployments. The original 1080 × 1920
rendition retains its audio and frame rate in Owncast, but is excluded from the
public master: its audio codec group can prevent desktop players from adapting
down when the uplink cannot sustain it. The portrait framing is preserved.

Owncast's HTTP/admin listener is fixed to `127.0.0.1:8082`; port 8080 can be
occupied by NVIDIA Broadcast on the mirrored Windows host. OBS keeps its
existing loopback RTMP input on port 1935 and its existing stream key. Only
the narrow nginx gateway on port 8090 is exposed through Funnel. Mobile video
and preview services retry every five seconds while the input is offline,
without latching into systemd's start-limit failure after an ordinary OBS stop.

The mobile encoder joins the newest completed segment with a bounded 128 KiB
probe and one-second analysis limit, rather than buffering an unbounded amount
of a quiet camera feed during startup. Its playlist keeps twelve six-second
segments, a 72-second recovery window. GOP 90 at 15 fps keeps keyframes aligned
with segment boundaries. Input buffering and B-frame delay are disabled; the output VBV is
about one second. Check media timestamps against Owncast's source segments when
measuring delay: a freshly modified playlist can still contain old frames.
Decoder, filter and encoder threads are explicitly bounded. Frames are selected
from the existing 30 fps source with `framestep=2`; an explicit 15 fps encoder
rate matches the actual frame selection. VFR preserves source timestamps
without duplicating obsolete frames across a skipped source interval. Packets
are flushed promptly. The loopback-only input helper on 127.0.0.1:8091 exposes
only the latest three source segments to the encoder, never a long archive.
Its only upstream is the fixed local Owncast video playlist; paths and segment
names are strictly validated, redirects and environment proxies are refused.
Owncast session IDs may contain URL-safe hyphens and underscores; the filename
allowlist accepts both so a new source session cannot disable the mobile feed.
Transient upstream network/HTTP failures get at most three bounded fetch
attempts. An already validated playlist can bridge a hiccup for at most three
seconds; malformed playlists, redirects and rejected paths never use that
fallback. FFmpeg also has two bounded segment retries. HTTP reconnect options
do not reliably apply to nested HLS playlist reloads, so the helper implements
that recovery instead of relying on those flags.
The helper reuses one upstream opener under its existing request lock. Creating
an opener in every request thread retains handler and SSL objects and can
exhaust its memory limit during a long broadcast. Its 128 MiB memory limit and
64 MiB swap limit remain bounded.
The public gateway has no route to this helper.
The mobile browser targets three segments behind the published edge (18 seconds)
and catches drift beyond six segments (36 seconds). Six-second segments leave
more time for a slow initial response before a live-edge correction interrupts
the download. Native Safari also catches accumulated lag after
playback starts. This small safety window absorbs relay latency; caching can
reduce duplicate upstream traffic but cannot speed up the first cold transfer.
This is ordinary HLS, so total camera-to-viewer delay still includes segment
completion, re-encoding, transport and the player's safety buffer.

The additional encoder runs as `owncast`, using `/opt/owncast/ffmpeg`. Its only
writable persistent directory is `/var/lib/chogcare-mobile`. Temporary segments,
directory listings, and symlinks are excluded by nginx. No admin password or
RTMP key is used. The master playlist's mobile codec string is verified from
the encoder's SPS: Main profile, constraint flag 1, level 3.1 (`avc1.4d401f`).

Install `mobile-input.py` as root-owned mode 0644 at
`/usr/local/lib/chogcare/mobile-input.py`, install and enable
`chogcare-mobile-input.service`, then place the mobile unit in
`/etc/systemd/system/chogcare-mobile.service`, verify it with
`systemd-analyze verify`, and run `systemctl daemon-reload` followed by
`systemctl enable --now chogcare-mobile`. Confirm the playlist is advancing
before applying `nginx-public.conf` to the existing site. Validate with
`nginx -t` and gracefully reload nginx. Owncast, OBS, payments and the Arduino
bridge do not need to restart. Preserve the previous nginx configuration before
replacing it.

Health checks: `systemctl status chogcare-mobile`, its systemd journal, and
`/hls/mobile/stream.m3u8`. Compare playlist sequence numbers several seconds
apart; test actual continuous playback through `https://chogcare.xyz`, rather
than just fetching the master playlist. A successful metadata event alone does
not demonstrate sustained video delivery.

### Recover a running process that stops producing new output

`broadcast-health.py` and `chogcare-broadcast-health.timer` add a local progress
check every fifteen seconds after each completed check. `Restart=always` alone
only recovers exited processes; a live FFmpeg process can keep fetching an
unchanged, valid playlist without producing new segments.

The check reads only the fixed loopback Owncast video playlist and the fixed
mobile playlist/preview files. A successful HTTP response or a touched playlist
does not prove progress: the source and mobile checks compare sequence/last-
segment identities. Preview progress uses its write timestamp so a static camera
scene remains valid. Missing, malformed, redirected or oversized source playlists
never authorize recovery. Both the monitor and each producer receive a
90-second startup grace. With a genuinely advancing upstream, thirty seconds
without mobile progress or twenty seconds without preview writes can request a
recovery of that component. Checks run on a timer, so detection also includes
the interval until the next check.

The only permitted actions are `systemctl try-restart --no-block` for
`chogcare-mobile.service` and `chogcare-preview.service`. Inactive/manual-stopped
services are left alone. Recovery attempts back off from 120 seconds to a
900-second maximum; cooldown is saved before requesting recovery. A reboot,
backwards clock or observation gap over five minutes starts a new grace period.
Backoff clears only after ten minutes of consecutive healthy progress checks;
an unhealthy sample, producer change or check gap over twenty seconds resets
that healthy streak. A brief recovery after a long stall does not clear backoff.
The root-only state directory `/var/lib/chogcare-broadcast-health` contains only
bounded health counters, clock values and hashed progress identities; no URLs,
segment names, credentials or payment information are retained. The service logs
only fixed recovery outcome/component codes.

Install the Python file root-owned, mode 0644, at
`/usr/local/lib/chogcare/broadcast-health.py` and the service/timer files in
`/etc/systemd/system/`. Validate both units with `systemd-analyze verify`, run
`systemctl daemon-reload`, then enable `chogcare-broadcast-health.timer` with
`systemctl enable --now chogcare-broadcast-health.timer`. These steps do not
restart the source or encoder. Run the isolated decision/parser tests with
`python3 -B test/broadcast-health.test.py`; they never restart real services.

The timer cannot recover an unavailable camera or a stopped OBS stream. It does
not restart Owncast, OBS, nginx, the public transport, payments or the USB station.
When the source is absent or unchanged, it waits for actual source progress.
Windows sleep still stops the local installation from serving viewers; checks
resume when WSL runs again and downstream recovery waits for a moving source.

`chogcare-preview.service` derives a 270 × 480 JPEG at quality 7 once per second from the
local mobile playlist. It only writes its own state directory and requires no
network access. Install and enable it like the mobile unit. The proxy exposes
only `/hls/mobile/preview.jpg`; Vercel's no-store HLS rule also applies to this
preview. The frontend shows the fresh frame while buffering, with the STREAM
status until actual playback starts. Temporary image files remain private.
Only hashed build assets under `/assets/` use immutable browser caching.
