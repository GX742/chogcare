$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$runtimeVersion = '24.22.0'
$archiveHash = 'F9683A19877E12A9B167305C8DB71040D812876359DE21F0D2E97C3F321F80C3'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectDirectory 'work\runtimes'
[void](New-Item -ItemType Directory -Path $runtimeDirectory -Force)
if ((Get-Item -LiteralPath $runtimeDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime directory must not be a reparse point.' }
$runtimeArchive = Join-Path $runtimeDirectory "node-v$runtimeVersion-win-x64.zip"
$runtimeTarget = Join-Path $runtimeDirectory "node-v$runtimeVersion-win-x64"
# Never replace an existing runtime: a running worker may still own it.
if (Test-Path -LiteralPath $runtimeTarget) { throw 'Portable runtime already exists. Verify it locally; this installer will not overwrite it.' }
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$runtimeVersion/node-v$runtimeVersion-win-x64.zip" -OutFile $runtimeArchive
if ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Official runtime archive hash mismatch. Nothing was executed.' }
Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeDirectory
$runtimeExecutable = Join-Path $runtimeTarget 'node.exe'
if ((& $runtimeExecutable --version) -ne "v$runtimeVersion") { throw 'Unexpected extracted runtime version.' }
Write-Output "Verified Node $runtimeVersion is ready. System Node, PATH and running payments were not changed."
