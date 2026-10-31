# Ingress timeline recovery

This optional watchdog detects sustained slow delivery into the dedicated
MediaMTX service. It reads only the authenticated loopback HLS master and video
playlist. It counts complete `EXTINF` durations and aligns overlapping segment
identities; open parts and program date-time never count as progress. A service
or publisher socket change, a new init segment, missing overlap, playlist
discontinuity, HTTP failure, or unsafe service state discards observation history.

The observer polls every five seconds using boot-scoped monotonic time. A
generation first needs 60 seconds of startup grace. After 20 seconds of healthy
progress, either less than half-speed delivery over 30 seconds or at least 15
seconds of accumulated media deficit over an anchor at least 60 seconds old can
request recovery. A source that never becomes healthy instead needs 120 seconds
of grace followed by a complete 60-second window below 0.8x with at least 15
seconds of deficit. The severe 30-second path requires another five-second confirmation. A latest
five-second interval at least 0.8x wall time cancels action; cumulative deficit
and never-healthy recovery already have their longer confirmation windows and do not require consecutive
slow ticks that would hide one-second segment quantization.

Before acting, the runtime must read a fresh playlist and recheck the active
service, no pending systemd job, exact publisher socket/process generation, and
init identity. Only then does it atomically persist restart intent and call the
fixed `systemctl --job-mode=fail try-restart chogcare-stream.service` command.
An interrupted or uncertain attempt consumes the same budget as success: no
more than one per five minutes and two per rolling hour, across generation
changes and module reloads. A new boot discards observations and conservatively
retains every prior outstanding intent for a full new hour. Corrupt state fails
closed. The service has no recovery action for OBS, payments, recording, or the
network configuration.

Installation and activation require a reviewed lease of the actual dedicated
MediaMTX unit, fixed executable/configuration, and reverse dependencies. The
runtime must refuse activation when stopping that unit could propagate to other
services. The root-owned state directory is private; neither state nor output
contains media URLs, credentials, socket addresses, or raw service logs. No
watchdog is installed or enabled merely by adding these source files.

This is a timeline-rate detector, not a trusted camera-clock measurement. It
cannot distinguish an already delayed stream progressing at 1x from a fresh
stream. Arm it only after checking a fresh healthy source; retain direct playback and decoded-frame checks
when assessing viewer latency.
