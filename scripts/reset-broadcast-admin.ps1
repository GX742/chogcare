# Reset only the local Owncast admin password using its official v0.3.0 CLI.
# The hidden password is transferred to WSL on stdin, never in Windows argv.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-OwncastRecoveryHelper {
  param([string]$Helper, [switch]$Check, [char[]]$PasswordChars)
  # Public helper code, not credentials, is encoded to avoid shell-quoting issues.
  $encodedHelper = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Helper))
  $bootstrap = "import base64;exec(base64.b64decode('$encodedHelper'))"
  $arguments = '-d Ubuntu -u root -- python3 -c "' + $bootstrap + '"'
  if ($Check) { $arguments += ' --check' }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = 'wsl.exe'
  $startInfo.Arguments = $arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (!$process.Start()) { throw 'Cannot start the local WSL recovery helper.' }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (!$Check) {
      # Validated ASCII characters need no JSON escaping. Do not make a separate
      # managed plaintext password string, shell command or temporary secret file.
      $process.StandardInput.Write('{"password":"')
      $process.StandardInput.Write($PasswordChars)
      $process.StandardInput.WriteLine('"}')
    }
    $process.StandardInput.Close()
    # The Linux helper has bounded operations and attempts to restore the normal
    # service in finally. Do not kill WSL mid-recovery and strand its child.
    $process.WaitForExit()
    $helperOutput = $outputTask.GetAwaiter().GetResult().Trim()
    $helperError = $errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      # Never relay raw external stderr: a failed launcher can include arguments.
      # Accept only one exact allowlisted phase code and display our own text.
      $safeErrors = @{
        'RECOVERY_ERROR:INPUT' = 'Hidden password input was rejected. No reset was started.'
        'RECOVERY_ERROR:PREFLIGHT' = 'Owncast setup verification failed before reset. No service was stopped.'
        'RECOVERY_ERROR:BACKUP' = 'Private Owncast backup failed BEFORE reset. The stream and password were not changed. Check the protected backup directory.'
        'RECOVERY_ERROR:STOP' = 'Owncast could not stop cleanly. Recovery was not started; restoring normal service was attempted.'
        'RECOVERY_ERROR:SPAWN' = 'The temporary Owncast recovery process could not start. Normal service restoration was attempted.'
        'RECOVERY_ERROR:SAVE' = 'Owncast did not confirm saving the password. It may already have changed. Normal service restoration was attempted; no old backup was restored.'
        'RECOVERY_ERROR:CLEANUP' = 'The temporary recovery process could not be stopped. Do not start a second Owncast process; inspect the local recovery process.'
        'RECOVERY_ERROR:RESTART' = 'Owncast normal service did not restart. Payment services were not touched; inspect the local Owncast service.'
        'RECOVERY_ERROR:VERIFY' = 'Owncast is running, but the new password could not be verified. Do not assume the reset succeeded.'
        'RECOVERY_ERROR:INTERNAL' = 'Local recovery failed before a verified result. No password was printed; check the local Owncast service.'
      }
      $safeCode = $helperError.Trim()
      if ($safeErrors.ContainsKey($safeCode)) { throw $safeErrors[$safeCode] }
      throw 'Owncast recovery did not complete. No password was printed. Check the local Owncast service; payment services were not touched.'
    }
    $expected = 'RESET_VERIFIED'
    if ($Check) { $expected = 'PREFLIGHT_OK' }
    if ($helperOutput -cne $expected) { throw 'Unexpected recovery result. Do not assume the password was reset.' }
  } finally {
    $helperOutput = $null
    $helperError = $null
    $process.Dispose()
  }
}

$recoveryPassword = $null
$recoveryRepeat = $null
$passwordPointer = [IntPtr]::Zero
$repeatPointer = [IntPtr]::Zero
$recoveryChars = $null

try {
  $helperPath = Join-Path $PSScriptRoot 'owncast-admin-recovery.py'
  $helperSource = [System.IO.File]::ReadAllText($helperPath, [System.Text.Encoding]::UTF8)
  Invoke-OwncastRecoveryHelper -Helper $helperSource -Check
  Write-Host 'Verified local Owncast v0.3.0. Only Owncast will briefly restart; OBS stream key and payments are not changed.'
  Write-Host 'Choose and save a NEW password: 14-72 characters, English upper/lowercase, a number and a symbol !@#$%^&*. No spaces.'
  Write-Host 'Keep it in your password manager. Never send it in chat. It is briefly visible only in the local Linux recovery process arguments.'
  $recoveryPassword = Read-Host 'New Owncast ADMIN password' -AsSecureString
  $recoveryRepeat = Read-Host 'Repeat new password' -AsSecureString
  if ($recoveryPassword.Length -lt 14 -or $recoveryPassword.Length -gt 72 -or $recoveryPassword.Length -ne $recoveryRepeat.Length) {
    throw 'Password length is invalid or confirmation differs. Nothing was changed.'
  }
  $passwordPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($recoveryPassword)
  $repeatPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($recoveryRepeat)
  $recoveryChars = New-Object char[] $recoveryPassword.Length
  $difference = 0
  $hasLower = $false; $hasUpper = $false; $hasNumber = $false; $hasSymbol = $false
  $allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
  for ($index = 0; $index -lt $recoveryPassword.Length; $index++) {
    $character = [int][System.Runtime.InteropServices.Marshal]::ReadInt16($passwordPointer, $index * 2) -band 0xffff
    $confirmation = [int][System.Runtime.InteropServices.Marshal]::ReadInt16($repeatPointer, $index * 2) -band 0xffff
    $difference = $difference -bor ($character -bxor $confirmation)
    $recoveryChars[$index] = [char]$character
    if ($allowed.IndexOf([char]$character) -lt 0) { throw 'Use only English letters, digits and !@#$%^&*. Nothing was changed.' }
    if ($character -ge 97 -and $character -le 122) { $hasLower = $true }
    if ($character -ge 65 -and $character -le 90) { $hasUpper = $true }
    if ($character -ge 48 -and $character -le 57) { $hasNumber = $true }
    if ('!@#$%^&*'.IndexOf([char]$character) -ge 0) { $hasSymbol = $true }
  }
  if ($difference -ne 0) { throw 'Password confirmation differs. Nothing was changed.' }
  if (!$hasLower -or !$hasUpper -or !$hasNumber -or !$hasSymbol) { throw 'Include uppercase, lowercase, a number and a symbol. Nothing was changed.' }
  Write-Host 'Creating a protected local Owncast backup and resetting its admin password. The stream may briefly disconnect.'
  Invoke-OwncastRecoveryHelper -Helper $helperSource -PasswordChars $recoveryChars
  Write-Host 'VERIFIED: new admin password works. Normal Owncast service is running without the password argument.'
  Write-Host 'Login at http://127.0.0.1:8082/admin/ as admin using your new password. Keep the new password saved.'
  Write-Host 'If OBS did not reconnect automatically, click Start Streaming. Payment terminals do not need a restart.'
} finally {
  if ($passwordPointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
  if ($repeatPointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($repeatPointer) }
  if ($null -ne $recoveryChars) { [Array]::Clear($recoveryChars, 0, $recoveryChars.Length) }
  if ($null -ne $recoveryPassword) { $recoveryPassword.Dispose() }
  if ($null -ne $recoveryRepeat) { $recoveryRepeat.Dispose() }
}
