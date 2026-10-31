// Static boundary checks: tests never start SSH, install units, or read private files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unitSource = readFileSync(new URL('../ops/relay/chogcare-relay.service', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../ops/relay/sshd-relay.conf', import.meta.url), 'utf8');

function meaningfulLines(source) {
  return source.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function parseUnit(source) {
  const sections = new Map();
  let current;
  for (const line of meaningfulLines(source)) {
    if (line.startsWith('[')) {
      current = new Map();
      assert.ok(!sections.has(line), `duplicate section ${line}`);
      sections.set(line, current);
      continue;
    }
    const separator = line.indexOf('=');
    assert.ok(current && separator > 0, 'expected a unit directive');
    const key = line.slice(0, separator);
    assert.ok(!current.has(key), `duplicate directive ${key}`);
    current.set(key, line.slice(separator + 1));
  }
  return sections;
}

const unit = parseUnit(unitSource);
const service = unit.get('[Service]');
const command = service.get('ExecStart').split(/\s+/);

function sshOptions(tokens) {
  const options = new Map();
  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (['-4', '-N', '-T', '-n', '-a', '-x'].includes(token)) {
      assert.ok(!options.has(token), `duplicate flag ${token}`);
      options.set(token, true);
      continue;
    }
    assert.ok(['-F', '-i', '-o', '-p', '-l', '-R'].includes(token), `unexpected SSH argument ${token}`);
    const value = tokens[++index];
    assert.ok(value && !value.startsWith('-'), 'expected one option value');
    const separator = value.indexOf('=');
    const key = token === '-o' ? value.slice(0, separator) : token;
    assert.ok(token !== '-o' || separator > 0, 'expected one named SSH option');
    assert.ok(!options.has(key), `duplicate option ${key}`);
    options.set(key, token === '-o' ? value.slice(separator + 1) : value);
  }
  return options;
}

const options = sshOptions(command);

test('relay opens exactly one fixed loopback reverse forward without a shell or extra command', () => {
  assert.equal(command[0], '/usr/bin/ssh');
  assert.equal(command.at(-1), '${RELAY_HOST}');
  assert.equal(command.filter(token => token.includes('$')).length, 1);
  assert.equal(options.get('-R'), '127.0.0.1:18090:127.0.0.1:8090');
  assert.equal(options.get('-p'), '22');
  assert.equal(options.get('-l'), 'chogcare-relay');
  for (const flag of ['-4', '-N', '-T', '-n', '-a', '-x']) assert.equal(options.get(flag), true);
  assert.equal(service.get('EnvironmentFile'), '/etc/chogcare-relay/relay.env');
  assert.equal([...service.keys()].filter(key => key.startsWith('Exec')).join(','), 'ExecStart');
  assert.doesNotMatch(service.get('ExecStart'), /[;|`]|\$\(|\/bin\/(?:ba)?sh|https?:\/\//);
});

test('relay authenticates only with the dedicated identity and pinned host key', () => {
  const expected = {
    '-F': '/dev/null', '-i': '/etc/chogcare-relay/id_ed25519',
    IdentitiesOnly: 'yes', IdentityAgent: 'none', AddKeysToAgent: 'no',
    BatchMode: 'yes', PreferredAuthentications: 'publickey',
    PasswordAuthentication: 'no', KbdInteractiveAuthentication: 'no',
    StrictHostKeyChecking: 'yes', UpdateHostKeys: 'no', VerifyHostKeyDNS: 'no',
    UserKnownHostsFile: '/etc/chogcare-relay/known_hosts', GlobalKnownHostsFile: '/dev/null',
    PermitLocalCommand: 'no', ProxyCommand: 'none', ProxyJump: 'none',
    ControlMaster: 'no', ControlPath: 'none',
    IPQoS: 'none',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(options.get(key), value, key);
  // Reject any future option outside the reviewed fixed transport and liveness settings.
  const allowed = new Set([...Object.keys(expected), '-4', '-N', '-T', '-n', '-a', '-x', '-p', '-l', '-R',
    'ExitOnForwardFailure', 'ServerAliveInterval', 'ServerAliveCountMax', 'ConnectTimeout']);
  for (const key of options.keys()) assert.ok(allowed.has(key), `unreviewed SSH option ${key}`);
});

test('a dead connection exits and restarts at a bounded rate without a start-limit latch', () => {
  assert.equal(options.get('ExitOnForwardFailure'), 'yes');
  assert.equal(options.get('ConnectTimeout'), '10');
  assert.equal(options.get('ServerAliveInterval'), '15');
  assert.equal(options.get('ServerAliveCountMax'), '3');
  assert.equal(service.get('Type'), 'simple');
  assert.equal(service.get('Restart'), 'always');
  assert.equal(service.get('RestartSec'), '5');
  assert.equal(unit.get('[Unit]').get('StartLimitIntervalSec'), '0');
  assert.equal(service.get('KillSignal'), 'SIGTERM');
  assert.equal(service.get('TimeoutStopSec'), '20');
  assert.equal(unit.get('[Unit]').get('After'), 'network-online.target nginx.service');
  assert.equal(unit.get('[Unit]').get('Wants'), 'network-online.target nginx.service');
});

test('relay runs unprivileged with read-only trust and suppresses raw SSH output', () => {
  assert.equal(service.get('User'), 'chogcare-relay');
  assert.equal(service.get('Group'), 'chogcare-relay');
  assert.equal(service.get('UMask'), '0077');
  for (const key of ['NoNewPrivileges', 'ProtectHome', 'PrivateTmp', 'PrivateDevices']) {
    assert.equal(service.get(key), 'true', key);
  }
  assert.equal(service.get('ProtectSystem'), 'strict');
  assert.equal(service.get('ReadOnlyPaths'), '/etc/chogcare-relay');
  assert.equal(service.get('CapabilityBoundingSet'), '');
  assert.equal(service.get('AmbientCapabilities'), '');
  assert.ok(!service.has('ReadWritePaths'));
  for (const key of ['StandardInput', 'StandardOutput', 'StandardError']) assert.equal(service.get(key), 'null');
  assert.doesNotMatch(unitSource + serverSource, /BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY|ssh-ed25519 AAAA|\b(?:\d{1,3}\.){3}\d{1,3}\b(?!:)/);
});

test('VPS restrictions apply only to the relay account and deny sessions and other forwarding', () => {
  const lines = meaningfulLines(serverSource);
  assert.equal(lines.shift(), 'Match User chogcare-relay');
  assert.equal(lines.pop(), 'Match all');
  const directives = new Map();
  for (const line of lines) {
    const [key, ...values] = line.split(/\s+/);
    assert.ok(!directives.has(key), `duplicate server directive ${key}`);
    directives.set(key, values.join(' '));
  }
  assert.deepEqual(Object.fromEntries(directives), {
    AuthenticationMethods: 'publickey', PubkeyAuthentication: 'yes',
    PasswordAuthentication: 'no', KbdInteractiveAuthentication: 'no',
    AllowAgentForwarding: 'no', AllowTcpForwarding: 'remote', AllowStreamLocalForwarding: 'no',
    GatewayPorts: 'no', PermitListen: '127.0.0.1:18090', PermitOpen: 'none',
    PermitTTY: 'no', X11Forwarding: 'no', PermitTunnel: 'no', PermitUserRC: 'no', MaxSessions: '0',
    ClientAliveInterval: '15', ClientAliveCountMax: '3',
    IPQoS: 'none',
  });
  assert.match(serverSource, /END of sshd_config/);
  assert.match(serverSource, /sshd -t before reloading/);
});
