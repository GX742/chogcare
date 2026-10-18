ChogCare serves the public HLS paths and the existing payment API through the
loopback nginx proxy on port 8090. Tailscale Funnel exposes this proxy; Vercel's
`/hls/:path*` rewrite keeps browser playback on the site's own origin. Playlists
and media responses are not cached by the Vercel rewrite.

The source stream remains in Owncast. `chogcare-mobile.service` reads that local
stream and produces a 720 × 1280, 24 fps H.264/AAC rendition at about 650 kbps,
including audio and transport overhead. The original 1080 × 1920 rendition
remains in the master playlist. Small screens and touch devices load the mobile
playlist directly, preventing native Safari from switching back to the heavy
rendition. Desktop players can select automatically from the master. Both
renditions use the same portrait aspect ratio and original
transport timestamps, so changing quality does not change the webpage's frame.

The additional encoder runs as `owncast`, using `/opt/owncast/ffmpeg`. Its only
writable persistent directory is `/var/lib/chogcare-mobile`. Temporary segments,
directory listings, and symlinks are excluded by nginx. No admin password or
RTMP key is used. The master playlist's mobile codec string is verified from
the encoder's SPS: Main profile, constraint flag 1, level 3.1 (`avc1.4d401f`).

To install this configuration on the existing host, place the unit in
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
