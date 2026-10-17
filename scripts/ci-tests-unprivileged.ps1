$ErrorActionPreference = 'Stop'
# This creates a disposable test identity ONLY on a GitHub-hosted Windows VM.
# Never run account provisioning on an operator workstation.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') { throw 'Hosted Windows CI only.' }
$workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_WORKSPACE).TrimEnd('\') + '\'
if (-not $workspace.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $workspace).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected CI workspace.' }
$ciName = 'chogtest' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$ciPassword = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
[Array]::Clear($bytes, 0, $bytes.Length)
$created = $null
$priorTemp = $env:TEMP; $priorTmp = $env:TMP
try {
  $created = New-LocalUser -Name $ciName -Password $ciPassword -AccountNeverExpires -Description 'Disposable ChogCare CI test identity'
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $created.SID
  $acl = Get-Acl -LiteralPath $workspace
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($created.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $workspace -AclObject $acl
  $temporary = Join-Path $workspace 'work\ci-temp'
  [void](New-Item -ItemType Directory -Path $temporary -Force)
  $env:TEMP = $temporary; $env:TMP = $temporary
  $node = (Get-Command node.exe).Source
  $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$ciName", $ciPassword)
  $stdout = Join-Path $temporary 'tests.stdout.log'
  $stderr = Join-Path $temporary 'tests.stderr.log'
  $child = Start-Process -FilePath $node -ArgumentList 'scripts/run-ci-tests.mjs' -Credential $credential -LoadUserProfile -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout }
  if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr }
  if ($child.ExitCode -ne 0) { throw "Unprivileged test process failed ($($child.ExitCode))." }
} finally {
  $env:TEMP = $priorTemp; $env:TMP = $priorTmp
  if ($created) { Remove-LocalUser -SID $created.SID }
}
