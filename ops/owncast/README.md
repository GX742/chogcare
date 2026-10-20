ChogCare serves the public HLS paths and the existing payment API through the
loopback nginx proxy on port 8090. Tailscale Funnel exposes this proxy; Vercel's
`/hls/:path*` rewrite keeps browser playback on the site's own origin. Playlists
and media responses are not cached by the Vercel rewrite.

The source stream remains in Owncast. `chogcare-mobile.service` reads that local
stream and produces a 720 × 1280, 15 fps H.264 video rendition with a 1,100 kbps
video target. The website always plays muted, so this rendition has no audio
scheduler or additional AAC encoding queue. The original 1080 × 1920 rendition
retains its audio and frame rate and
remains in the master playlist. Small screens and touch devices load the mobile
playlist directly, preventing native Safari from switching back to the heavy
rendition. Desktop players can select automatically from the master. Both
renditions use the same portrait aspect ratio and original
transport timestamps, so changing quality does not change the webpage's frame.

The mobile encoder joins the newest completed segment with a bounded 128 KiB
probe and one-second analysis limit, rather than buffering an unbounded amount
of a quiet camera feed during startup. Its playlist keeps eight one-second
segments. Input buffering and B-frame delay are disabled; the output VBV is
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
The public gateway has no route to this helper.
The browser targets three segments behind the published edge and limits drift;
native Safari also catches substantial accumulated lag after playback starts.
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

`chogcare-preview.service` derives a 360 × 640 JPEG once per second from the
local mobile playlist. It only writes its own state directory and requires no
network access. Install and enable it like the mobile unit. The proxy exposes
only `/hls/mobile/preview.jpg`; Vercel's no-store HLS rule also applies to this
preview. The frontend shows the fresh frame while buffering, with the STREAM
status until actual playback starts. Temporary image files remain private.
Only hashed build assets under `/assets/` use immutable browser caching.
