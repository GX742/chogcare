param([Parameter(Mandatory=$true)][string]$WorkspacePath)
$ErrorActionPreference = 'Stop'
try {
  $stationDirectory = Join-Path $WorkspacePath 'work\station'
  $remoteFile = Join-Path $stationDirectory 'remote.json'
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($candidate in @((Join-Path $WorkspacePath 'work'), $stationDirectory, $remoteFile)) {
    $item = Get-Item -LiteralPath $candidate -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked storage.' }
  }
  $acl = Get-Acl -LiteralPath $remoteFile
  if (-not $acl.AreAccessRulesProtected) { throw 'Inherited access.' }
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -notin $allowedSids) { throw 'Unexpected owner.' }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids) { throw 'Unexpected access.' }
  }
  exit 0
} catch { exit 1 }
