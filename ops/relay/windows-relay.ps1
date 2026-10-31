[CmdletBinding()]
param(
  [string]$RelayHost = '',
  [string]$IdentityFile = '',
  [string]$KnownHostsFile = '',
  [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'

# BEGIN CHOGCARE RELAY POLICY
$script:ChogCareRelayPolicy = @'
{
  "user": "chogcare-relay",
  "port": 22,
  "forward": "127.0.0.1:18090:127.0.0.1:8090",
  "restartSeconds": 5,
  "serverAliveInterval": 15,
  "serverAliveCountMax": 3,
  "arguments": ["-4", "-N", "-T", "-n", "-a", "-x", "-F", "NUL"],
  "options": {
    "IdentitiesOnly": "yes",
    "IdentityAgent": "none",
    "AddKeysToAgent": "no",
    "BatchMode": "yes",
    "PreferredAuthentications": "publickey",
    "PasswordAuthentication": "no",
    "KbdInteractiveAuthentication": "no",
    "StrictHostKeyChecking": "yes",
    "UpdateHostKeys": "no",
    "VerifyHostKeyDNS": "no",
    "GlobalKnownHostsFile": "NUL",
    "ExitOnForwardFailure": "yes",
    "IPQoS": "none",
    "ConnectTimeout": "10",
    "PermitLocalCommand": "no",
    "ProxyCommand": "none",
    "ProxyJump": "none",
    "ControlMaster": "no",
    "ControlPath": "none"
  }
}
'@ | ConvertFrom-Json
# END CHOGCARE RELAY POLICY

function Assert-ChogCareRelayPublicIpv4 {
  param([string]$Value)
  $address = $null
  if (![System.Net.IPAddress]::TryParse($Value, [ref]$address) -or
      $address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
      $address.ToString() -cne $Value) { throw 'A canonical public IPv4 is required.' }
  $octets = $address.GetAddressBytes()
  $a = [int]$octets[0]; $b = [int]$octets[1]; $c = [int]$octets[2]
  if ($a -eq 0 -or $a -eq 10 -or $a -eq 127 -or $a -ge 224 -or
      ($a -eq 100 -and $b -ge 64 -and $b -le 127) -or
      ($a -eq 169 -and $b -eq 254) -or
      ($a -eq 172 -and $b -ge 16 -and $b -le 31) -or
      ($a -eq 192 -and ($b -eq 168 -or ($b -eq 0 -and $c -in @(0,2)) -or ($b -eq 88 -and $c -eq 99))) -or
      ($a -eq 198 -and ($b -in @(18,19) -or ($b -eq 51 -and $c -eq 100))) -or
      ($a -eq 203 -and $b -eq 0 -and $c -eq 113)) { throw 'A public unicast IPv4 is required.' }
}

function Get-ChogCareRelayArguments {
  param([string]$RelayHost, [string]$IdentityFile, [string]$KnownHostsFile)
  Assert-ChogCareRelayPublicIpv4 $RelayHost
  foreach ($path in @($IdentityFile, $KnownHostsFile)) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path -match '["\x00-\x1f]') { throw 'A regular credential path is required.' }
  }
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($argument in $script:ChogCareRelayPolicy.arguments) { $result.Add([string]$argument) }
  $result.Add('-i'); $result.Add([System.IO.Path]::GetFullPath($IdentityFile))
  foreach ($option in $script:ChogCareRelayPolicy.options.PSObject.Properties) {
    $result.Add('-o'); $result.Add($option.Name + '=' + [string]$option.Value)
  }
  $known = [System.IO.Path]::GetFullPath($KnownHostsFile).Replace('\','/')
  $result.Add('-o'); $result.Add('UserKnownHostsFile="' + $known + '"')
  $result.Add('-o'); $result.Add('ServerAliveInterval=' + $script:ChogCareRelayPolicy.serverAliveInterval)
  $result.Add('-o'); $result.Add('ServerAliveCountMax=' + $script:ChogCareRelayPolicy.serverAliveCountMax)
  $result.Add('-p'); $result.Add([string]$script:ChogCareRelayPolicy.port)
  $result.Add('-l'); $result.Add([string]$script:ChogCareRelayPolicy.user)
  $result.Add('-R'); $result.Add([string]$script:ChogCareRelayPolicy.forward)
  $result.Add($RelayHost)
  return $result.ToArray()
}

function ConvertTo-ChogCareNativeArgument {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value -or $Value.IndexOf([char]0) -ge 0) { throw 'Invalid native argument.' }
  $builder = New-Object System.Text.StringBuilder
  $null = $builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]'\') { $slashes++; continue }
    if ($character -eq [char]'"') {
      $null = $builder.Append(('\' * (2 * $slashes + 1)))
      $null = $builder.Append('"')
    } else {
      $null = $builder.Append(('\' * $slashes))
      $null = $builder.Append($character)
    }
    $slashes = 0
  }
  $null = $builder.Append(('\' * (2 * $slashes)))
  $null = $builder.Append('"')
  return $builder.ToString()
}

function Initialize-ChogCareRelayJobType {
  if ('ChogCareRelayJob' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class ChogCareRelayJob : IDisposable {
    private readonly SafeJobHandle job;
    private ChogCareRelayJob() {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x00002000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
            int error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(error);
        }
    }
    // Self-assignment occurs before starting SSH, removing the launch/assign race.
    // Closing this unnamed job kills this isolated supervisor and its children.
    public static ChogCareRelayJob AssignCurrentProcess() {
        var owner = new ChogCareRelayJob();
        using (var process = Process.GetCurrentProcess()) {
            if (!AssignProcessToJobObject(owner.job, process.Handle)) {
                int error = Marshal.GetLastWin32Error();
                owner.job.Dispose();
                throw new Win32Exception(error);
            }
        }
        return owner;
    }
    public void Dispose() { job.Dispose(); }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    private sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid {
        public SafeJobHandle() : base(true) { }
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern SafeJobHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeJobHandle job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeJobHandle job, IntPtr process);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@
}

function Assert-ChogCarePrivateRelayFile {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer -or $item.Length -le 0 -or
      ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Credential metadata rejected.' }
  $acl = Get-Acl -LiteralPath $Path
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid -or $rules.Count -ne 2) { throw 'Credential ACL rejected.' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin @($currentSid, 'S-1-5-18') -or $rule.AccessControlType -ne 'Allow') { throw 'Credential principal rejected.' }
  }
}

if ($LibraryOnly) { return }

$mutex = $null; $ownsMutex = $false; $job = $null; $child = $null
try {
  # Never attach an interactive/shared PowerShell host to the private kill job.
  $hostArguments = [System.Environment]::GetCommandLineArgs()
  $isolatedFile = $false
  for ($index = 0; $index -lt $hostArguments.Length - 1; $index++) {
    if ($hostArguments[$index] -ieq '-File' -and
        [System.IO.Path]::GetFullPath($hostArguments[$index + 1]) -ieq $PSCommandPath) { $isolatedFile = $true; break }
  }
  if (!$isolatedFile) { throw 'Run this supervisor in its own PowerShell -File process.' }
  $arguments = @(Get-ChogCareRelayArguments -RelayHost $RelayHost -IdentityFile $IdentityFile -KnownHostsFile $KnownHostsFile)
  Assert-ChogCarePrivateRelayFile $IdentityFile
  Assert-ChogCarePrivateRelayFile $KnownHostsFile
  $sshPath = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
  if (!(Test-Path -LiteralPath $sshPath -PathType Leaf)) { throw 'Windows OpenSSH is unavailable.' }
  $mutex = New-Object System.Threading.Mutex($false, 'Local\ChogCareNativePublicRelay')
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (!$ownsMutex) { exit 0 }
  Initialize-ChogCareRelayJobType
  $job = [ChogCareRelayJob]::AssignCurrentProcess()
  while ($true) {
    $child = $null
    try {
      $start = New-Object System.Diagnostics.ProcessStartInfo
      $start.FileName = $sshPath
      $start.Arguments = (($arguments | ForEach-Object { ConvertTo-ChogCareNativeArgument $_ }) -join ' ')
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
      $start.RedirectStandardInput = $true
      $start.RedirectStandardOutput = $true
      $start.RedirectStandardError = $true
      $child = New-Object System.Diagnostics.Process
      $child.StartInfo = $start
      if (!$child.Start()) { throw 'Native client start failed.' }
      $child.StandardInput.Close()
      $outputDrain = $child.StandardOutput.ReadToEndAsync()
      $errorDrain = $child.StandardError.ReadToEndAsync()
      $child.WaitForExit()
      $null = $outputDrain.GetAwaiter().GetResult()
      $null = $errorDrain.GetAwaiter().GetResult()
    } catch {
      # Never emit raw SSH diagnostics, paths or network identities.
    } finally {
      if ($null -ne $child) {
        try { if (!$child.HasExited) { $child.Kill(); $child.WaitForExit(5000) | Out-Null } } catch {}
        $child.Dispose()
      }
    }
    Start-Sleep -Seconds $script:ChogCareRelayPolicy.restartSeconds
  }
} catch {
  exit 64
} finally {
  if ($ownsMutex -and $null -ne $mutex) { try { $mutex.ReleaseMutex() } catch {} }
  if ($null -ne $mutex) { $mutex.Dispose() }
  # This closes only this supervisor's unnamed job; unrelated SSH is never killed.
  if ($null -ne $job) { $job.Dispose() }
}
