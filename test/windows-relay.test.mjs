import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const relayPath = fileURLToPath(new URL("../ops/relay/windows-relay.ps1", import.meta.url));
const source = readFileSync(relayPath, "utf8");
const windowsOnly = process.platform === "win32" ? false : "Requires Windows PowerShell and Windows Job Objects.";
// Never select executable code through inherited environment variables or PATH.
const powerShell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;
const commandArguments = command => [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
];
const library = `$ErrorActionPreference = 'Stop'\n. ${quotePowerShell(relayPath)} -LibraryOnly\n`;
const fixedFlags = ["-4", "-N", "-T", "-n", "-a", "-x", "-F", "NUL"];
const fixedOptions = {
  IdentitiesOnly: "yes", IdentityAgent: "none", AddKeysToAgent: "no", BatchMode: "yes",
  PreferredAuthentications: "publickey", PasswordAuthentication: "no", KbdInteractiveAuthentication: "no",
  StrictHostKeyChecking: "yes", UpdateHostKeys: "no", VerifyHostKeyDNS: "no", GlobalKnownHostsFile: "NUL",
  ExitOnForwardFailure: "yes", IPQoS: "none", ConnectTimeout: "10", PermitLocalCommand: "no",
  ProxyCommand: "none", ProxyJump: "none", ControlMaster: "no", ControlPath: "none",
};

function runPowerShell(command, timeout = 20_000) {
  const result = spawnSync(powerShell, commandArguments(command), {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1_048_576,
  });
  assert.equal(result.error, undefined, "The isolated PowerShell check must complete within its deadline.");
  assert.equal(result.status, 0, "The isolated PowerShell check failed; native output is withheld.");
  return result.stdout.trim();
}

function jsonPowerShell(command, timeout) {
  const output = runPowerShell(command, timeout);
  try { return JSON.parse(output); }
  catch { assert.fail("The isolated PowerShell check must return only safe structured output."); }
}

function relayPolicy() {
  const block = source.match(/# BEGIN CHOGCARE RELAY POLICY\s*\r?\n([\s\S]*?)# END CHOGCARE RELAY POLICY/);
  assert.ok(block, "The relay must expose its fixed, reviewable policy.");
  const start = block[1].indexOf("{");
  const end = block[1].lastIndexOf("}");
  assert.ok(start >= 0 && end > start, "The relay policy must contain a JSON object.");
  return JSON.parse(block[1].slice(start, end + 1));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function waitUntil(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return check();
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

function readyMessage(child, timeout) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("The isolated Job Object supervisor did not become ready.")), timeout);
    function finish(error, result) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(result);
    }
    function onError() { finish(new Error("The isolated Job Object supervisor could not start.")); }
    function onExit() { finish(new Error("The isolated Job Object supervisor exited before assigning its dummy child.")); }
    function onData(chunk) {
      output += chunk;
      if (output.length > 4096) return finish(new Error("Unexpected isolated supervisor output."));
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try { finish(null, JSON.parse(output.slice(0, newline).trim())); }
      catch { finish(new Error("The isolated Job Object supervisor returned invalid structured output.")); }
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("Windows relay policy binds the restricted account and loopback forwarding contract", () => {
  const policy = relayPolicy();
  assert.equal(policy.restartSeconds, 5);
  assert.equal(policy.serverAliveInterval, 15);
  assert.equal(policy.serverAliveCountMax, 3);
  assert.equal(policy.user, "chogcare-relay");
  assert.equal(policy.port, 22);
  assert.equal(policy.forward, "127.0.0.1:18090:127.0.0.1:8090");
  assert.deepEqual(policy.arguments, fixedFlags);
  assert.deepEqual(policy.options, fixedOptions);
});

test("Windows relay library loading and argument generation perform no operational work", { skip: windowsOnly }, () => {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
foreach ($name in @('Get-Acl', 'Set-Acl', 'Start-Process', 'Get-Content', 'Set-Content', 'Get-Item', 'Test-Path', 'New-Item', 'Copy-Item', 'Move-Item', 'Remove-Item', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Add-Type')) {
    Set-Item -Path ('Function:global:' + $name) -Value { throw 'LIBRARY_PERFORMED_OPERATIONAL_WORK' }
}
` + `. ${quotePowerShell(relayPath)} -LibraryOnly\n` + String.raw`
$arguments = @(Get-ChogCareRelayArguments -RelayHost '8.8.8.8' -IdentityFile 'C:\Synthetic relay\id_ed25519' -KnownHostsFile 'C:\Synthetic relay\known_hosts')
ConvertTo-Json -InputObject $arguments -Compress
`;
  const arguments_ = jsonPowerShell(command);
  assert.ok(Array.isArray(arguments_));
  assert.deepEqual(arguments_, [
    ...fixedFlags, "-i", "C:\\Synthetic relay\\id_ed25519",
    ...Object.entries(fixedOptions).flatMap(([name, value]) => ["-o", `${name}=${value}`]),
    "-o", 'UserKnownHostsFile="C:/Synthetic relay/known_hosts"',
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-p", "22", "-l", "chogcare-relay", "-R", "127.0.0.1:18090:127.0.0.1:8090", "8.8.8.8",
  ]);
});

test("Windows relay rejects option injection, nonpublic destinations and malformed credential paths", { skip: windowsOnly }, () => {
  const hosts = [
    "", "-oProxyCommand=synthetic", "8.8.8.8 -R 0:0:0", "8.8.8.8\nignored", "8.8.8.8;ignored",
    "relay.synthetic.invalid", "134744072", "008.8.8.8", "8.8.8.8/32", "8.8.8.8:22", "::1",
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.2", "172.16.1.2",
    "192.168.1.2", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
  ];
  const paths = ["", " ", 'C:\\synthetic"quoted', "C:\\synthetic\nline", "C:\\synthetic\tpath"];
  const command = library + `$hosts = @(${hosts.map(quotePowerShell).join(", ")})\n` +
    `$paths = @(${paths.map(quotePowerShell).join(", ")})\n` + String.raw`
$results = @()
foreach ($destination in $hosts) {
    try {
        $null = @(Get-ChogCareRelayArguments -RelayHost $destination -IdentityFile 'C:\Synthetic relay\id_ed25519' -KnownHostsFile 'C:\Synthetic relay\known_hosts')
        $results += $false
    } catch { $results += $true }
}
foreach ($path in $paths) {
    foreach ($parameter in @('IdentityFile', 'KnownHostsFile')) {
        $parameters = @{ RelayHost = '8.8.8.8'; IdentityFile = 'C:\Synthetic relay\id_ed25519'; KnownHostsFile = 'C:\Synthetic relay\known_hosts' }
        $parameters[$parameter] = $path
        try { $null = @(Get-ChogCareRelayArguments @parameters); $results += $false }
        catch { $results += $true }
    }
}
try { $null = ConvertTo-ChogCareNativeArgument ([string][char]0); $results += $false }
catch { $results += $true }
ConvertTo-Json -InputObject $results -Compress
`;
  assert.deepEqual(jsonPowerShell(command), Array(hosts.length + paths.length * 2 + 1).fill(true));
});

test("Windows relay validates synthetic credential metadata and owner/SYSTEM ACLs without reading files", { skip: windowsOnly }, () => {
  const command = library + String.raw`
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$world = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
function New-SyntheticRule($principal, $rights) {
    return New-Object System.Security.AccessControl.FileSystemAccessRule($principal, $rights, $allow)
}
function Reset-SyntheticCredential {
    $script:syntheticItem = [pscustomobject]@{
        PSIsContainer = $false
        Length = 42
        Attributes = [System.IO.FileAttributes]::Normal
    }
    $script:syntheticAcl = New-Object System.Security.AccessControl.FileSecurity
    $script:syntheticAcl.SetOwner($owner)
    $script:syntheticAcl.SetAccessRuleProtection($true, $false)
    $script:syntheticAcl.AddAccessRule((New-SyntheticRule $owner $fullControl))
    $script:syntheticAcl.AddAccessRule((New-SyntheticRule $system $fullControl))
}
function global:Get-Item {
    param([string]$LiteralPath)
    if ($LiteralPath -ne 'C:\Synthetic relay\id_ed25519') { throw 'UNEXPECTED_SYNTHETIC_PATH' }
    return $script:syntheticItem
}
function global:Get-Acl {
    param([string]$LiteralPath)
    if ($LiteralPath -ne 'C:\Synthetic relay\id_ed25519') { throw 'UNEXPECTED_SYNTHETIC_PATH' }
    return $script:syntheticAcl
}
$results = @()
foreach ($caseName in @('strict', 'broader', 'worldRead', 'reparse', 'directory', 'empty', 'unprotected', 'wrongOwner')) {
    Reset-SyntheticCredential
    switch ($caseName) {
        'broader' {
            $script:syntheticAcl.PurgeAccessRules($system)
            $script:syntheticAcl.AddAccessRule((New-SyntheticRule $administrators $fullControl))
        }
        'worldRead' {
            $script:syntheticAcl.AddAccessRule((New-SyntheticRule $world ([System.Security.AccessControl.FileSystemRights]::Read)))
        }
        'reparse' { $script:syntheticItem.Attributes = [System.IO.FileAttributes]::ReparsePoint }
        'directory' { $script:syntheticItem.PSIsContainer = $true }
        'empty' { $script:syntheticItem.Length = 0 }
        'unprotected' { $script:syntheticAcl.SetAccessRuleProtection($false, $false) }
        'wrongOwner' { $script:syntheticAcl.SetOwner($system) }
    }
    $accepted = $false
    try { Assert-ChogCarePrivateRelayFile 'C:\Synthetic relay\id_ed25519'; $accepted = $true }
    catch { }
    $results += @{ caseName = $caseName; accepted = $accepted }
}
ConvertTo-Json -InputObject $results -Compress
`;
  assert.deepEqual(jsonPowerShell(command), [
    { caseName: "strict", accepted: true },
    ...["broader", "worldRead", "reparse", "directory", "empty", "unprotected", "wrongOwner"].map(caseName => ({ caseName, accepted: false })),
  ]);
});

test("Windows native argument quoting round-trips literal tokens without shell evaluation", { skip: windowsOnly }, () => {
  const tokens = [
    "", "plain", "two words", "tab\there", 'embedded"quote', "C:\\trailing\\",
    "C:\\space directory\\", 'backslash\\\\"quote', "кириллица", "'single'",
    "--looks-like-an-option", "literal ; & | $() ` < > %PATH%",
  ];
  const echoScript = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  const arguments_ = ["-e", echoScript, "--", ...tokens];
  const command = library + `$tokens = @(${arguments_.map(quotePowerShell).join(", ")})\n` + String.raw`
$info = New-Object System.Diagnostics.ProcessStartInfo
` + `$info.FileName = ${quotePowerShell(process.execPath)}\n` + String.raw`
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.Arguments = (@($tokens | ForEach-Object { ConvertTo-ChogCareNativeArgument $_ }) -join ' ')
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
$started = $false
try {
    if (-not $child.Start()) { throw 'ARGUMENT_ROUND_TRIP_START_FAILED' }
    $started = $true
    $output = $child.StandardOutput.ReadToEnd()
    if (-not $child.WaitForExit(5000) -or $child.ExitCode -ne 0) { throw 'ARGUMENT_ROUND_TRIP_FAILED' }
    [Console]::Write($output)
} finally {
    if ($started -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(3000) }
    $child.Dispose()
}
`;
  assert.deepEqual(jsonPowerShell(command), tokens);
});

test("Windows relay refuses a shared command host before credential or process operations", { skip: windowsOnly }, () => {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
foreach ($name in @('Get-Item', 'Get-Acl', 'Test-Path', 'Add-Type', 'Start-Process')) {
    Set-Item -Path ('Function:global:' + $name) -Value {
        [Console]::WriteLine('ISOLATED_HOST_GUARD_WAS_BYPASSED')
        throw 'ISOLATED_HOST_GUARD_WAS_BYPASSED'
    }
}
` + `& ${quotePowerShell(relayPath)} -RelayHost '8.8.8.8' -IdentityFile 'C:\\Synthetic relay\\id_ed25519' -KnownHostsFile 'C:\\Synthetic relay\\known_hosts'\nexit $LASTEXITCODE\n`;
  const result = spawnSync(powerShell, commandArguments(command), {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576,
  });
  assert.equal(result.error, undefined, "The isolated host-guard check must finish within its deadline.");
  assert.equal(result.status, 64, "The supervisor must reject a host that did not launch its own -File path.");
  assert.equal(result.stdout.trim(), "", "The isolation guard must run before operational work.");
});

test("hard-stopping an isolated Windows relay supervisor kills its own dummy child only", { skip: windowsOnly, timeout: 40_000 }, async () => {
  // Both ping processes are bounded, even if the Job Object code regresses.
  // No task, SSH process, key, listener or production host is used.
  const ping = String.raw`C:\Windows\System32\PING.EXE`;
  const sentinel = spawn(ping, ["-n", "31", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
  let supervisor;
  let dummyPid;
  try {
    const command = library + String.raw`
Initialize-ChogCareRelayJobType
$job = [ChogCareRelayJob]::AssignCurrentProcess()
$info = New-Object System.Diagnostics.ProcessStartInfo
` + `$info.FileName = ${quotePowerShell(ping)}\n` + String.raw`
$info.Arguments = '-n 11 127.0.0.1'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$dummy = New-Object System.Diagnostics.Process
$dummy.StartInfo = $info
if (-not $dummy.Start()) { throw 'DUMMY_CHILD_START_FAILED' }
$dummy.BeginOutputReadLine()
$dummy.BeginErrorReadLine()
[Console]::WriteLine((@{ dummyPid = $dummy.Id } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
`;
    supervisor = spawn(powerShell, commandArguments(command), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const ready = await readyMessage(supervisor, 20_000);
    dummyPid = ready.dummyPid;
    assert.ok(Number.isInteger(dummyPid) && dummyPid > 0);
    assert.ok(isAlive(dummyPid), "The dummy must be alive before stopping its supervisor.");
    assert.equal(sentinel.exitCode, null, "The independent sentinel must still be alive.");
    assert.equal(supervisor.kill(), true, "Stop only the exact supervisor launched by this test.");
    await waitForExit(supervisor);
    assert.equal(await waitUntil(() => !isAlive(dummyPid), 3000), true, "The supervisor's Job Object must terminate its dummy child promptly.");
    assert.equal(sentinel.exitCode, null, "A child outside the private Job Object must survive.");
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill();
      await waitForExit(supervisor);
    }
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill();
    await waitForExit(sentinel);
    if (dummyPid && isAlive(dummyPid)) await waitUntil(() => !isAlive(dummyPid), 12_000);
  }
});
