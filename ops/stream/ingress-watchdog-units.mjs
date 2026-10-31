/** Source-only units. Installing/enabling these requires a separate reviewed cutover. */
export function renderIngressWatchdogService() {
  return `[Unit]
Description=ChogCare bounded ingress timeline watchdog
After=chogcare-stream.service

[Service]
Type=oneshot
User=root
Group=root
StateDirectory=chogcare-ingress-watchdog
StateDirectoryMode=0700
UMask=0077
UnsetEnvironment=NODE_OPTIONS NODE_USE_ENV_PROXY HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
LoadCredential=hls-reader-token:/etc/chogcare-stream/hls-reader-token
ExecStart=/usr/bin/flock --exclusive --nonblock --conflict-exit-code=75 --no-fork /var/lib/chogcare-ingress-watchdog/execution.lock /opt/chogcare-node-v24.22.0/bin/node /opt/chogcare-ingress-watchdog/ingress-watchdog-runtime.mjs --tick
TimeoutStartSec=45s
TimeoutStopSec=5s
MemoryMax=96M
MemorySwapMax=0
TasksMax=16
CPUWeight=10
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=default
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
IPAddressDeny=any
IPAddressAllow=localhost
InaccessiblePaths=-/var/lib/chogcare -/var/lib/chogcare-station -/etc/chogcare
StandardOutput=journal
StandardError=journal
`;
}

export function renderIngressWatchdogTimer() {
  return `[Unit]
Description=Check ChogCare ingress completed-media advancement

[Timer]
OnBootSec=45s
OnUnitInactiveSec=5s
AccuracySec=500ms
RandomizedDelaySec=0
Unit=chogcare-ingress-watchdog.service

[Install]
WantedBy=timers.target
`;
}
