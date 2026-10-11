// Static checks only: never import/run the privileged firewall script in tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source=readFileSync(new URL("../scripts/harden-node-firewall.ps1",import.meta.url),"utf8");
const tcp='TCP Query User{A6605924-9566-4EA5-A62B-DD61456ACDEF}C:\\program files\\nodejs\\node.exe';
const udp='UDP Query User{4418AF90-556E-48ED-8FEE-43D19BB1A711}C:\\program files\\nodejs\\node.exe';

test("firewall helper targets only the two exact verified public Node.js rules",()=>{
  assert.ok(source.includes(`Name = '${tcp}'`));assert.ok(source.includes(`Name = '${udp}'`));
  assert.equal((source.match(/Name = '[^']+'/g)??[]).length,2);
  assert.ok(source.includes("$expectedProgram = 'C:\\program files\\nodejs\\node.exe'"));
  assert.match(source,/\[string\]\$_\.Name -ceq \$Name/);
  assert.match(source,/\[string\]\$Rule\.Profile -cne 'Public'/);
  assert.match(source,/\[string\]\$Rule\.Direction -cne 'Inbound'/);
  assert.match(source,/\[string\]\$Rule\.Action -cne 'Allow'/);
  assert.match(source,/OrdinalIgnoreCase\.Equals\(\[string\]\$applications\[0\]\.Program, \$expectedProgram\)/);
  for(const field of ["LocalPort","RemotePort"])assert.ok(source.includes(`Assert-Any $ports[0].${field}`));
  for(const field of ["LocalAddress","RemoteAddress"])assert.ok(source.includes(`Assert-Any $addresses[0].${field}`));
  assert.match(source,/\$list\.Count -ne 1.*-cne 'Any'/);
});

test("firewall helper requires administrator, preflights every target and supports WhatIf",()=>{
  assert.match(source,/CmdletBinding\(SupportsShouldProcess = \$true/);
  assert.match(source,/WindowsIdentity\]::GetCurrent\(\)/);
  assert.match(source,/IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.ok(source.indexOf("IsInRole(")<source.indexOf("function Read-ExactRule"));
  const preflight=source.indexOf("foreach ($target in $targets)");
  const mutation=source.indexOf("Disable-NetFirewallRule -Name");
  assert.ok(preflight>=0&&preflight<source.indexOf("$changed =")&&source.indexOf("$changed =")<mutation);
  assert.match(source,/Assert-ExactTarget \$rule \$target\s+if \(\[string\]\$rule\.Enabled/);
  assert.match(source,/if \(\$PSCmdlet\.ShouldProcess\([^\n]+\)\) \{\s+Disable-NetFirewallRule/);
  assert.match(source,/Disable-NetFirewallRule -Name \$target\.Name -PolicyStore PersistentStore -ErrorAction Stop/);
  assert.match(source,/Already absent:/);assert.match(source,/Already disabled:/);
  assert.match(source,/Assert-ExactTarget \$verified \$target/);
});

test("firewall helper never broadens network access, elevates itself or restarts services",()=>{
  assert.doesNotMatch(source,/New-NetFirewallRule|Set-NetFirewallProfile|Set-NetFirewallRule|Remove-NetFirewallRule|Start-Process|RunAs|Stop-Process|Restart-Service|tailscale\s+(?:serve|funnel|up)/i);
  assert.doesNotMatch(source,/^\s*Enable-NetFirewallRule\b/m);
  assert.equal((source.match(/\bDisable-NetFirewallRule\b/g)??[]).length,1);
  assert.match(source,/finally \{[\s\S]*Rollback \(administrator PowerShell\): Enable-NetFirewallRule -Name '\{0\}' -PolicyStore PersistentStore/);
  assert.doesNotMatch(source,/Get-NetFirewallRule[^\n]+-ErrorAction SilentlyContinue/);
});
