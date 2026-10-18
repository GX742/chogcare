param(
  [Parameter(Mandatory = $true)][string]$WorkspacePath,
  [Parameter(Mandatory = $true)][ValidateSet('support', 'admin')][string]$Kind
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Local operations ACL setup requires Windows.' }
# Use the .NET filesystem/Access APIs directly. No module discovery, shell
# providers or first-run module-analysis cache is needed to protect these ACLs.

$workspaceDirectory = [IO.Path]::GetFullPath($WorkspacePath)
if ($workspaceDirectory.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($workspaceDirectory)) { throw 'A local workspace is required.' }
$workDirectory = [IO.Path]::Combine($workspaceDirectory, 'work')
$storageDirectory = [IO.Path]::Combine($workDirectory, $Kind)
foreach ($directory in @($workspaceDirectory, $workDirectory, $storageDirectory)) {
  $item = [IO.DirectoryInfo]::new($directory)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked operations storage is not supported.' }
}
$files = @(([IO.DirectoryInfo]::new($storageDirectory)).GetFileSystemInfos())
foreach ($file in $files) {
  $allowed = if ($Kind -eq 'support') { $file.Name -cmatch '^support\.sqlite(?:-(?:wal|shm|journal))?\z' } else { $file.Name -ceq 'settings.json' -or $file.Name -cmatch '^settings-[a-f0-9]{24}\.tmp\z' }
  if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $allowed) { throw 'Unexpected local operations storage item.' }
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
# Work with the Access section only. Set-Acl attempts to copy the complete
# descriptor, including Audit/SACL, and can require SeSecurityPrivilege on a
# second run. Owner, group and audit policy must not be read or changed here.
$accessSection = [Security.AccessControl.AccessControlSections]::Access
function Test-PrivateDacl($Acl, [bool]$IsDirectory) {
  if (-not $Acl.AreAccessRulesProtected) { return $false }
  $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $allowedSids.Count) { return $false }
  $found = [Collections.Generic.HashSet[string]]::new()
  $inheritance = if ($IsDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
        $allowedSids.Value -notcontains $rule.IdentityReference.Value -or -not $found.Add($rule.IdentityReference.Value)) { return $false }
  }
  return $true
}
function Protect-PrivateDacl([IO.FileSystemInfo]$Item) {
  $isDirectory = $Item -is [IO.DirectoryInfo]
  $current = $Item.GetAccessControl($accessSection)
  if (Test-PrivateDacl $current $isDirectory) { return }
  $desired = if ($isDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $desired.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowedSids) {
    $rule = if ($isDirectory) { [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') } else { [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow') }
    [void]$desired.AddAccessRule($rule)
  }
  # Mark and persist only the DACL. This requires WRITE_DAC, not audit or
  # ownership privileges, and never introduces broad inherited access.
  $current.SetSecurityDescriptorSddlForm($desired.GetSecurityDescriptorSddlForm($accessSection), $accessSection)
  $Item.SetAccessControl($current)
  if (-not (Test-PrivateDacl ($Item.GetAccessControl($accessSection)) $isDirectory)) { throw 'Private operations permissions could not be verified.' }
}
Protect-PrivateDacl ([IO.DirectoryInfo]::new($storageDirectory))
foreach ($file in $files) { Protect-PrivateDacl ([IO.FileInfo]::new($file.FullName)) }
[Console]::Out.WriteLine('Local operations storage is restricted to this account, SYSTEM and Administrators.')
