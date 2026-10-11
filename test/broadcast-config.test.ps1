# Isolated unit tests: parse the tuning script, load functions only, and mock API
# reads. Never execute its main body, password prompt, backup, or live requests.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$parseErrors = $null
$sourcePath = Join-Path $PSScriptRoot '../scripts/configure-broadcast.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Tuning script has syntax errors.' }
# Execute the exact production credential-encoding block with synthetic values
# in Windows PowerShell 5.1. HttpClient is never asked to send a request.
Add-Type -AssemblyName System.Net.Http
$authBlocks = @($ast.FindAll({
  param($node)
  ($node -is [System.Management.Automation.Language.TryStatementAst]) -and
  ($node.Body.Statements.Count -gt 0) -and
  ($node.Body.Statements[0].Extent.Text -match '^\$broadcastPasswordPointer\s*=.*SecureStringToBSTR')
}, $true))
if ($authBlocks.Count -ne 1) { throw 'Cannot identify the production auth encoding block.' }
foreach ($syntheticPassword in @('dummy-test-only-password', 'dummy:!@#$%^&*()+= test', "dummy$([char]0x0410)$([char]0x00e9)$([char]0xd83d)$([char]0xde00)")) {
  $broadcastClient = New-Object System.Net.Http.HttpClient
  $broadcastPassword = New-Object System.Security.SecureString
  foreach ($character in $syntheticPassword.ToCharArray()) { $broadcastPassword.AppendChar($character) }
  $broadcastPassword.MakeReadOnly()
  $broadcastPasswordPointer = [IntPtr]::Zero
  $broadcastPasswordChars = $null
  $broadcastPasswordBytes = $null
  $broadcastAuthorization = $null
  try {
    . ([scriptblock]::Create($authBlocks[0].Extent.Text))
    $expected = 'Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('admin:' + $syntheticPassword))
    if ($broadcastClient.DefaultRequestHeaders.Authorization.ToString() -cne $expected) { throw 'Production Basic Auth encoding mismatch.' }
    if ($broadcastPasswordPointer -ne [IntPtr]::Zero) { throw 'Credential pointer was not cleared.' }
    if ($null -ne $broadcastPassword) { throw 'SecureString was not disposed.' }
    foreach ($value in $broadcastPasswordChars) { if ([int]$value -ne 0) { throw 'Credential character buffer was not cleared.' } }
    foreach ($value in $broadcastPasswordBytes) { if ($value -ne 0) { throw 'Credential byte buffer was not cleared.' } }
  } finally { $broadcastClient.Dispose() }
}
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($function.Extent.Text))
}
$script:mockAdmin = [pscustomobject]@{
  adminPassword = 'FAKE-SECRET-NOT-A-CREDENTIAL'
  streamKeys = @('FAKE-STREAM-KEY')
  videoCodec = 'libx264'
  videoSettings = [pscustomobject]@{
    latencyLevel = 2
    videoQualityVariants = @([pscustomobject]@{
      name = ''; videoPassthrough = $false; audioPassthrough = $true
      videoBitrate = 1200; audioBitrate = 0; framerate = 24; cpuUsageLevel = 2
      extraSecret = 'FAKE-SECRET-NOT-A-CREDENTIAL'
    })
  }
}
function Invoke-LocalOwncastJson {
  param([string]$Method, [string]$Route)
  if (($Method -ne 'GET') -or ($Route -ne '/api/admin/serverconfig')) { throw 'Unexpected mocked request.' }
  return $script:mockAdmin
}
$safe = Get-SafeBroadcastSettings
if (($safe.videoQualityVariants -isnot [array]) -or ($safe.videoQualityVariants.Count -ne 1)) { throw 'Single-variant array was lost.' }
if (($safe.videoQualityVariants[0].scaledWidth -ne 0) -or ($safe.videoQualityVariants[0].scaledHeight -ne 0)) { throw 'Optional dimensions were not normalized.' }
$json = ConvertTo-Json -InputObject $safe -Depth 8
if ($json -match 'adminPassword|streamKeys|extraSecret|FAKE-') { throw 'Secret fields leaked into the safe projection.' }
$roundTrip = ConvertFrom-Json -InputObject $json
if (!(Test-BroadcastSettingsEqual $roundTrip $safe)) { throw 'Backup round-trip changed streaming settings.' }
$script:mockAdmin.videoCodec = 'unrecognized-codec'
$refused = $false
try { $null = Get-SafeBroadcastSettings } catch { $refused = $true }
if (!$refused) { throw 'Unexpected codec was accepted.' }
foreach ($invalid in @('30', -1, 1.5, [double]::PositiveInfinity)) {
  $refused = $false
  try { $null = Get-BroadcastInteger $invalid } catch { $refused = $true }
  if (!$refused) { throw 'Malformed integer was accepted.' }
}
Write-Output 'Broadcast configuration isolated checks passed; no live requests or writes.'
