$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This ACL utility is for Windows only.' }
# Use this shell's own module, not a PSModulePath inherited from PowerShell 7.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$projectDirectory = Split-Path -Parent $PSScriptRoot
$storageDirectory = Join-Path $projectDirectory 'work\payments'
if (-not (Test-Path -LiteralPath $storageDirectory -PathType Container)) { throw 'Payment storage does not exist.' }
$storageItem = Get-Item -LiteralPath $storageDirectory
if ($storageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to change permissions on a reparse point.' }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))

# Change only this project's payment-storage ACL. No keys or backup contents are
# read, copied or displayed. Inherited rules propagate to normal descendants.
$taskAcl = [Security.AccessControl.DirectorySecurity]::new()
$taskAcl.SetAccessRuleProtection($true, $false)
foreach ($sid in $allowedSids) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  [void]$taskAcl.AddAccessRule($rule)
}
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [IO.Directory]::SetAccessControl($storageItem.FullName, $taskAcl)
} else {
  Set-Acl -LiteralPath $storageItem.FullName -AclObject $taskAcl
}
Write-Output 'Payment storage is restricted to the current Windows account, SYSTEM and Administrators.'
Write-Output 'This does not protect against malware running as your own account or an administrator.'
