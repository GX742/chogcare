#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# These are the two previously verified PUBLIC inbound Node.js allowances.
# No wildcard, executable discovery, new rule, private-network rule or service
# is changed. Run manually in an administrator PowerShell; -WhatIf is supported.
$expectedProgram = 'C:\program files\nodejs\node.exe'
$targets = @(
    @{ Name = 'TCP Query User{A6605924-9566-4EA5-A62B-DD61456ACDEF}C:\program files\nodejs\node.exe'; Protocol = 'TCP'; ProtocolNumber = '6' },
    @{ Name = 'UDP Query User{4418AF90-556E-48ED-8FEE-43D19BB1A711}C:\program files\nodejs\node.exe'; Protocol = 'UDP'; ProtocolNumber = '17' }
)

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This script is only for Windows. Nothing was changed.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script manually in an administrator PowerShell. Nothing was changed.'
}

function Read-ExactRule {
    param([string]$Name)
    # Enumerating a fixed policy store lets a missing rule be distinguished from
    # an access/provider error. Errors are never swallowed as "already removed".
    $found = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
        Where-Object { [string]$_.Name -ceq $Name })
    if ($found.Count -gt 1) { throw 'Duplicate exact firewall rule. Nothing more will be changed.' }
    if ($found.Count -eq 0) { return $null }
    return $found[0]
}

function Assert-Any {
    param($Values)
    $list = @($Values)
    if ($list.Count -ne 1 -or [string]$list[0] -cne 'Any') {
        throw 'The firewall rule scope changed: expected only Any. Nothing more will be changed.'
    }
}

function Assert-ExactTarget {
    param($Rule, $Target)
    if ([string]$Rule.Name -cne $Target.Name -or [string]$Rule.Profile -cne 'Public' -or
        [string]$Rule.Direction -cne 'Inbound' -or [string]$Rule.Action -cne 'Allow' -or
        [string]$Rule.Enabled -cnotin @('True', 'False')) {
        throw 'The firewall rule identity or policy changed. Nothing more will be changed.'
    }
    $applications = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
    $ports = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
    $addresses = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
    if ($applications.Count -ne 1 -or $ports.Count -ne 1 -or $addresses.Count -ne 1 -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals([string]$applications[0].Program, $expectedProgram) -or
        [string]$ports[0].Protocol -cnotin @($Target.Protocol, $Target.ProtocolNumber)) {
        throw 'The firewall program or protocol changed. Nothing more will be changed.'
    }
    Assert-Any $ports[0].LocalPort
    Assert-Any $ports[0].RemotePort
    Assert-Any $addresses[0].LocalAddress
    Assert-Any $addresses[0].RemoteAddress
}

# Validate ALL existing targets before the first mutation. A missing or already
# disabled target is safe and idempotent; a renamed/rescoped target is not.
foreach ($target in $targets) {
    $rule = Read-ExactRule $target.Name
    if ($null -ne $rule) { Assert-ExactTarget $rule $target }
}

$changed = New-Object 'System.Collections.Generic.List[string]'
try {
    foreach ($target in $targets) {
        # Recheck immediately before each change, not only during preflight.
        $rule = Read-ExactRule $target.Name
        if ($null -eq $rule) {
            Write-Host ('Already absent: {0} public Node.js rule.' -f $target.Protocol)
            continue
        }
        Assert-ExactTarget $rule $target
        if ([string]$rule.Enabled -ceq 'False') {
            Write-Host ('Already disabled: {0} public Node.js rule.' -f $target.Protocol)
            continue
        }
        if ($PSCmdlet.ShouldProcess($target.Name, 'Disable this exact Public inbound Node.js Allow rule')) {
            Disable-NetFirewallRule -Name $target.Name -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
            $changed.Add($target.Name)
            $verified = Read-ExactRule $target.Name
            if ($null -eq $verified) { throw 'Firewall readback failed. Check the precise rollback instructions below.' }
            Assert-ExactTarget $verified $target
            if ([string]$verified.Enabled -cne 'False') { throw 'The firewall rule is still enabled. Check the precise rollback instructions below.' }
            Write-Host ('VERIFIED: {0} public Node.js inbound allowance disabled.' -f $target.Protocol)
        }
    }
    Write-Host 'Finished. No new firewall rule was created. Private-network rules, Tailscale, OBS and payment processes were not changed.'
} finally {
    foreach ($name in $changed) {
        # Text only: rollback is an explicit separate administrator action.
        Write-Host ("Rollback (administrator PowerShell): Enable-NetFirewallRule -Name '{0}' -PolicyStore PersistentStore" -f $name)
    }
}
