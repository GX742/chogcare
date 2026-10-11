# Configure only Owncast v0.3.0 streaming settings, using its local admin API.
# The script never stops OBS, restarts services, changes keys or touches payments.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-BroadcastProperty {
  param([object]$Object, [string]$Name, [switch]$Optional)
  if ($null -eq $Object) { throw 'Unexpected Owncast configuration schema.' }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    if ($Optional) { return $null }
    throw 'Unexpected Owncast configuration schema.'
  }
  # Preserve JSON arrays even when they contain just one output variant.
  return ,$property.Value
}

function Get-BroadcastInteger {
  param([object]$Value, [int]$Minimum = 0, [int]$Maximum = 2147483647)
  if (($Value -isnot [int]) -and ($Value -isnot [long]) -and ($Value -isnot [double]) -and ($Value -isnot [decimal])) {
    throw 'Unexpected integer in Owncast streaming settings.'
  }
  if (($Value -lt $Minimum) -or ($Value -gt $Maximum) -or ([math]::Truncate([double]$Value) -ne $Value)) {
    throw 'Owncast streaming setting is outside the supported range.'
  }
  return [int]$Value
}

function ConvertTo-SafeBroadcastVariant {
  param([object]$Variant)
  $name = Get-BroadcastProperty $Variant 'name'
  $videoPassthrough = Get-BroadcastProperty $Variant 'videoPassthrough'
  $audioPassthrough = Get-BroadcastProperty $Variant 'audioPassthrough'
  if (($name -isnot [string]) -or ($name.Length -gt 128) -or ($videoPassthrough -isnot [bool]) -or ($audioPassthrough -isnot [bool])) {
    throw 'Unexpected Owncast output variant schema.'
  }
  $width = Get-BroadcastProperty $Variant 'scaledWidth' -Optional
  $height = Get-BroadcastProperty $Variant 'scaledHeight' -Optional
  if ($null -eq $width) { $width = 0 }
  if ($null -eq $height) { $height = 0 }
  # Explicit projection: never copy/spread the complete admin response.
  return [pscustomobject][ordered]@{
    name = $name
    videoPassthrough = $videoPassthrough
    audioPassthrough = $audioPassthrough
    videoBitrate = Get-BroadcastInteger (Get-BroadcastProperty $Variant 'videoBitrate') -Maximum 100000
    audioBitrate = Get-BroadcastInteger (Get-BroadcastProperty $Variant 'audioBitrate') -Maximum 1024
    scaledWidth = Get-BroadcastInteger $width -Maximum 8192
    scaledHeight = Get-BroadcastInteger $height -Maximum 8192
    framerate = Get-BroadcastInteger (Get-BroadcastProperty $Variant 'framerate') -Maximum 240
    cpuUsageLevel = Get-BroadcastInteger (Get-BroadcastProperty $Variant 'cpuUsageLevel') -Maximum 4
  }
}

function Invoke-LocalOwncastJson {
  param(
    [ValidateSet('GET', 'POST')][string]$Method,
    [ValidateSet('/api/config', '/api/admin/serverconfig', '/api/admin/config/video/streamlatencylevel', '/api/admin/config/video/streamoutputvariants')][string]$Route,
    [object]$Body
  )
  $readRoute = ($Route -eq '/api/config') -or ($Route -eq '/api/admin/serverconfig')
  if (($readRoute -and ($Method -ne 'GET')) -or ((!$readRoute) -and ($Method -ne 'POST'))) {
    throw 'Unsupported Owncast request.'
  }
  # Fixed literal origin. No URL, port, redirect or proxy supplied by a user/server.
  $request = New-Object System.Net.Http.HttpRequestMessage
  $request.Method = New-Object System.Net.Http.HttpMethod($Method)
  $request.RequestUri = [uri]('http://127.0.0.1:8080' + $Route)
  $response = $null
  $responseText = $null
  $parsed = $null
  try {
    if ($Method -eq 'POST') {
      $json = ConvertTo-Json -InputObject $Body -Depth 8 -Compress
      $request.Content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
    }
    try { $response = $broadcastClient.SendAsync($request).GetAwaiter().GetResult() }
    catch { throw 'Cannot reach the local Owncast API. No remote server was contacted.' }
    if (!$response.IsSuccessStatusCode) {
      # Do not print response bodies, requests, credentials or exception details.
      if ([int]$response.StatusCode -eq 401) {
        throw 'Owncast admin login rejected (HTTP 401). Use the Owncast ADMIN password, not the OBS/RTMP stream key or another account password. Check the same password at http://127.0.0.1:8080/admin/ (username: admin). Never send the password in chat.'
      }
      throw ('Owncast API rejected the request (HTTP {0}). Check the local admin password and server.' -f [int]$response.StatusCode)
    }
    try {
      $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $parsed = ConvertFrom-Json -InputObject $responseText
    } catch { throw 'Owncast returned an invalid JSON response.' }
    if ($Method -eq 'POST') {
      $success = Get-BroadcastProperty $parsed 'success'
      if (($success -isnot [bool]) -or !$success) { throw 'Owncast did not confirm the settings update.' }
    }
    return $parsed
  } finally {
    $responseText = $null
    $parsed = $null
    if ($null -ne $response) { $response.Dispose() }
    $request.Dispose()
  }
}

function Get-SafeBroadcastSettings {
  $adminResponse = $null
  try {
    $adminResponse = Invoke-LocalOwncastJson -Method GET -Route '/api/admin/serverconfig'
    # Level 2 has a verified meaning only for this selected server codec.
    # Refuse another codec rather than change the codec or guess its preset.
    $codec = Get-BroadcastProperty $adminResponse 'videoCodec'
    if (($codec -isnot [string]) -or ($codec -cne 'libx264')) {
      throw 'This script requires the existing Owncast video codec libx264. No codec was changed.'
    }
    $settings = Get-BroadcastProperty $adminResponse 'videoSettings'
    $variantsValue = Get-BroadcastProperty $settings 'videoQualityVariants'
    if (($variantsValue -isnot [array]) -or ($variantsValue.Count -lt 1) -or ($variantsValue.Count -gt 10)) {
      throw 'Unexpected Owncast output variant list. No settings were changed.'
    }
    $safeVariants = @($variantsValue | ForEach-Object { ConvertTo-SafeBroadcastVariant $_ })
    return [pscustomobject][ordered]@{
      latencyLevel = Get-BroadcastInteger (Get-BroadcastProperty $settings 'latencyLevel') -Maximum 4
      videoQualityVariants = $safeVariants
    }
  } finally {
    # The full response includes admin/stream/storage credentials. Never output
    # or back it up; only the explicit, non-secret projection may leave here.
    $adminResponse = $null
  }
}

function Test-BroadcastSettingsEqual {
  param([object]$Actual, [object]$Expected)
  $actualJson = ConvertTo-Json -InputObject $Actual -Depth 8 -Compress
  $expectedJson = ConvertTo-Json -InputObject $Expected -Depth 8 -Compress
  return ($actualJson -ceq $expectedJson)
}

function Save-SafeBroadcastBackup {
  param([object]$Settings)
  $projectPath = Split-Path -Parent $PSScriptRoot
  $backupDirectory = Join-Path $projectPath 'work/broadcast'
  $null = New-Item -ItemType Directory -Path $backupDirectory -Force
  $backupName = 'owncast-video-{0}-{1}.json' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), [guid]::NewGuid().ToString('N')
  $backupPath = Join-Path $backupDirectory $backupName
  $backupBytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Settings -Depth 8))
  # CreateNew cannot overwrite an existing backup.
  $backupFile = [System.IO.File]::Open($backupPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $backupFile.Write($backupBytes, 0, $backupBytes.Length) }
  finally { $backupFile.Dispose() }
  return $backupPath
}

$broadcastHandler = New-Object System.Net.Http.HttpClientHandler
$broadcastHandler.AllowAutoRedirect = $false
$broadcastHandler.UseProxy = $false
$broadcastHandler.UseCookies = $false
$broadcastClient = New-Object System.Net.Http.HttpClient($broadcastHandler)
$broadcastClient.Timeout = [TimeSpan]::FromSeconds(20)
$broadcastClient.DefaultRequestHeaders.Accept.ParseAdd('application/json')
$broadcastClient.DefaultRequestHeaders.Add('X-Owncast-CSRF-Protection', '1')
$broadcastPassword = $null
$broadcastPasswordPointer = [IntPtr]::Zero
$broadcastPasswordChars = $null
$broadcastPasswordBytes = $null
$broadcastAuthorization = $null
$broadcastOriginal = $null
$broadcastBackupPath = $null
$broadcastVariantsAttempted = $false
$broadcastLatencyAttempted = $false

try {
  # This unauthenticated check precedes both the password prompt and any write.
  $publicConfig = Invoke-LocalOwncastJson -Method GET -Route '/api/config'
  $version = Get-BroadcastProperty $publicConfig 'version'
  if (($version -isnot [string]) -or ($version -cne 'Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)')) {
    throw 'Unsupported Owncast version/build. Expected the installed official v0.3.0 Linux build (4b09...). No settings were changed.'
  }
  $publicConfig = $null
  Write-Host 'Local Owncast v0.3.0 verified. Enter its admin password only in this hidden prompt, never in chat or a command argument.'
  $broadcastPassword = Read-Host 'Owncast admin password' -AsSecureString
  if ($broadcastPassword.Length -eq 0) { throw 'No password entered. No settings were changed.' }
  # Encode Basic Auth without making a separate managed plaintext password string.
  try {
    $broadcastPasswordPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($broadcastPassword)
    $broadcastPasswordChars = New-Object char[] ($broadcastPassword.Length + 6)
    'admin:'.CopyTo(0, $broadcastPasswordChars, 0, 6)
    for ($index = 0; $index -lt $broadcastPassword.Length; $index++) {
      $broadcastPasswordChars[$index + 6] = [char]([int][System.Runtime.InteropServices.Marshal]::ReadInt16($broadcastPasswordPointer, $index * 2) -band 0xffff)
    }
    $broadcastPasswordBytes = [System.Text.Encoding]::UTF8.GetBytes($broadcastPasswordChars)
    $broadcastAuthorization = [Convert]::ToBase64String($broadcastPasswordBytes)
    $broadcastClient.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Basic', $broadcastAuthorization)
  } finally {
    if ($broadcastPasswordPointer -ne [IntPtr]::Zero) {
      [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($broadcastPasswordPointer)
      $broadcastPasswordPointer = [IntPtr]::Zero
    }
    if ($null -ne $broadcastPasswordChars) { [Array]::Clear($broadcastPasswordChars, 0, $broadcastPasswordChars.Length) }
    if ($null -ne $broadcastPasswordBytes) { [Array]::Clear($broadcastPasswordBytes, 0, $broadcastPasswordBytes.Length) }
    $broadcastAuthorization = $null
    if ($null -ne $broadcastPassword) { $broadcastPassword.Dispose(); $broadcastPassword = $null }
  }

  $broadcastOriginal = Get-SafeBroadcastSettings
  $broadcastDesired = [pscustomobject][ordered]@{
    latencyLevel = 0
    videoQualityVariants = @([pscustomobject][ordered]@{
      name = '1080p'
      videoPassthrough = $false
      audioPassthrough = $false
      videoBitrate = 4500
      audioBitrate = 128
      scaledWidth = 1080
      scaledHeight = 0
      framerate = 30
      # Owncast v0.3.0 libx264 mapping: 2 = veryfast (not the NVENC P5 preset).
      cpuUsageLevel = 2
    })
  }
  if (Test-BroadcastSettingsEqual $broadcastOriginal $broadcastDesired) {
    Write-Host 'These streaming settings are already saved. No settings were changed.'
  } else {
    $broadcastBackupPath = Save-SafeBroadcastBackup $broadcastOriginal
    Write-Host ('Non-secret video settings backup: {0}' -f $broadcastBackupPath)
    $preflightSettings = Get-SafeBroadcastSettings
    if (!(Test-BroadcastSettingsEqual $preflightSettings $broadcastOriginal)) {
      throw 'Streaming settings changed during setup. Nothing was overwritten; run the script again.'
    }
    # Mark attempts before dispatch: a lost response can still mean a saved write.
    $broadcastVariantsAttempted = $true
    $null = Invoke-LocalOwncastJson -Method POST -Route '/api/admin/config/video/streamoutputvariants' -Body @{ value = $broadcastDesired.videoQualityVariants }
    $broadcastLatencyAttempted = $true
    $null = Invoke-LocalOwncastJson -Method POST -Route '/api/admin/config/video/streamlatencylevel' -Body @{ value = $broadcastDesired.latencyLevel }
    $savedSettings = Get-SafeBroadcastSettings
    if (!(Test-BroadcastSettingsEqual $savedSettings $broadcastDesired)) { throw 'Owncast settings readback did not match the requested values.' }
    Write-Host 'Verified: one 1080-pixel-wide output, original aspect ratio, 30 fps, 4500 kbps, audio 128 kbps, libx264 veryfast, latency level 0.'
  }
  Write-Host 'The saved settings apply to the next OBS stream start. When ready, stop/start the stream in OBS yourself; do not restart Owncast or payment services.'
  Write-Host 'Lowest-latency HLS is still several seconds behind the camera, not an instant feed.'
} catch {
  $rollbackFailed = $false
  if (($null -ne $broadcastOriginal) -and ($broadcastVariantsAttempted -or $broadcastLatencyAttempted)) {
    Write-Warning 'Configuration failed. Restoring only the streaming fields attempted by this script.'
    if ($broadcastVariantsAttempted) {
      try { $null = Invoke-LocalOwncastJson -Method POST -Route '/api/admin/config/video/streamoutputvariants' -Body @{ value = $broadcastOriginal.videoQualityVariants } }
      catch { $rollbackFailed = $true }
    }
    if ($broadcastLatencyAttempted) {
      try { $null = Invoke-LocalOwncastJson -Method POST -Route '/api/admin/config/video/streamlatencylevel' -Body @{ value = $broadcastOriginal.latencyLevel } }
      catch { $rollbackFailed = $true }
    }
    try {
      $restoredSettings = Get-SafeBroadcastSettings
      if (!(Test-BroadcastSettingsEqual $restoredSettings $broadcastOriginal)) { $rollbackFailed = $true }
    } catch { $rollbackFailed = $true }
    if ($rollbackFailed) {
      throw ('Automatic rollback could not be verified. Do not restart the stream yet. Restore video/latency in local Owncast admin using the non-secret backup: {0}' -f $broadcastBackupPath)
    }
    throw 'Configuration failed; the original streaming settings were restored and verified. The running stream and payments were not stopped.'
  }
  throw
} finally {
  if ($broadcastPasswordPointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($broadcastPasswordPointer) }
  if ($null -ne $broadcastPasswordChars) { [Array]::Clear($broadcastPasswordChars, 0, $broadcastPasswordChars.Length) }
  if ($null -ne $broadcastPasswordBytes) { [Array]::Clear($broadcastPasswordBytes, 0, $broadcastPasswordBytes.Length) }
  if ($null -ne $broadcastPassword) { $broadcastPassword.Dispose() }
  $broadcastClient.DefaultRequestHeaders.Authorization = $null
  $broadcastAuthorization = $null
  $broadcastClient.Dispose()
  $broadcastHandler.Dispose()
}
