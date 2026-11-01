# Local OBS publisher recovery

`obs-publisher-recovery.mjs` is a pure decision engine and a bounded transaction
coordinator. It installs nothing and opens no socket. A separate, explicitly
enabled per-user Windows video agent owns its lifecycle. Admin payments,
support, USB and VPN controls are outside its scope.

The agent uses authenticated OBS on fixed loopback port 4455 and GET-only public
HLS checks at the enrolled site and verified HTTPS origin. It must not follow
redirects, forward cookies/tokens, change enrolled origins during a run, or persist raw OBS
responses, source names, destination settings, keys or passwords. It privately
validates the intended service/profile/camera configuration and passes only a
binding hash. A session hash must include a fresh authenticated-connection
generation: reconnecting the agent cannot resume an old recovery transaction.
HTTP health is not decoded-camera proof.

`evaluate` requires a prior 20-second period of valid advancing video at both
endpoints, an active non-reconnecting OBS session at least 120 seconds old,
advancing duration/bytes/frames, and unchanged session/config bindings. Only
dual confirmed 404 responses for at least 60 seconds and four samples with no
gap over 15 seconds can recommend recovery. Timeouts, 5xx, auth failures,
malformed playlists and one-sided failures break consecutive failure evidence.
Frozen 200 responses cannot establish a healthy anchor. API loss, pause,
configuration switching, unexpected stops and inactive outputs disarm evidence.
The runtime keeps intentional stops disarmed until a new explicit user session.

The runtime supplies boot-scoped monotonic milliseconds, validates the private
state with `validateState`, and holds an exclusive single-instance lock through
load, reservation and RPC. The state contains only hashes, timestamps, counters
and booleans. Persist `reserveRecovery` before any StopStream: at most one
attempt per five minutes and two per rolling hour. Unknown outcomes consume the
reservation. Process restarts preserve the ledger; boot changes conservatively
hold previous reservations for a new full hour. Never delete/reset the ledger
to regain availability.

`recoverPublisher` persists first, rechecks fresh dual 404 plus active OBS, sends
StopStream once, and requires a positive acknowledgment. Within a 15-second
deadline and at most 20 fixed 500 ms polls it requires two stopped observations
with the same connection/session/config and cancellation epoch before one
StartStream. Every RPC/inspection also needs its own runtime deadline. Pause,
close, config changes, timeout or ambiguity prevent StartStream. There is no
automatic transaction resume after a crash and no forced process termination.

The optional `connectLocalObs({onRecoveryEvent})` subscribes only to Config and
Outputs (66). It exposes projected stream states, four config event types and
connection closure. All pending and new RPCs are refused during configuration
switching. Default callers still subscribe to zero events. The runtime cancels
immediately on config/connection changes and on any stop outside its explicitly
owned stop phase; configuration fields never change as part of recovery.

OBS's standard `StreamStateChanged` carries no actor/request identifier. A user
stop coinciding exactly with the agent's own stop cannot always be attributed.
Use a visible Pause/Disable control and refuse ambiguous acknowledgments or
events rather than claiming an absolute intent guarantee. No settings, stream
key, scene, audio routing, VPN mode or network route is modified. Supported
contracts: [OBS event protocol](https://github.com/obsproject/obs-websocket/blob/5.6.3/docs/generated/protocol.md#streamstatechanged)
and [collection-switching warning](https://github.com/obsproject/obs-websocket/blob/5.6.3/docs/generated/protocol.md#currentscenecollectionchanging).
