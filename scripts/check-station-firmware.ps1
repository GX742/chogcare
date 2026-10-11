param(
  [string]$CliPath,
  [string]$ArduinoData,
  [string]$ArduinoUser
)

$ErrorActionPreference = 'Stop'
$stationProject = Split-Path -Parent $PSScriptRoot
if (!$CliPath) {
  $stationCommand = Get-Command arduino-cli -ErrorAction SilentlyContinue
  $CliPath = if ($stationCommand) { $stationCommand.Source } else {
    Join-Path $env:LOCALAPPDATA 'Programs/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'
  }
}
if (!(Test-Path -LiteralPath $CliPath -PathType Leaf)) { throw 'Arduino CLI was not found. Pass -CliPath to the CLI bundled with Arduino IDE.' }
if (!$ArduinoData) { $ArduinoData = Join-Path $env:LOCALAPPDATA 'Arduino15' }
if (!$ArduinoUser) { $ArduinoUser = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino' }
$stationLibraries = Join-Path $ArduinoUser 'libraries'
if (!(Test-Path -LiteralPath $stationLibraries -PathType Container)) { throw 'Install the display libraries in the Arduino sketchbook first. See firmware/README.md.' }
$stationPreviousData = $env:ARDUINO_DIRECTORIES_DATA
$stationPreviousUser = $env:ARDUINO_DIRECTORIES_USER
try {
  $env:ARDUINO_DIRECTORIES_DATA = $ArduinoData
  $env:ARDUINO_DIRECTORIES_USER = $ArduinoUser
  # Compile only: no upload command, COM argument, network listener or signer.
  & $CliPath compile --fqbn esp8266:esp8266:nodemcuv2 --libraries $stationLibraries --build-path (Join-Path $stationProject 'work/arduino-build') (Join-Path $stationProject 'firmware/chogcare_station')
  if ($LASTEXITCODE -ne 0) { throw "Firmware compilation failed with exit code $LASTEXITCODE." }
} finally {
  $env:ARDUINO_DIRECTORIES_DATA = $stationPreviousData
  $env:ARDUINO_DIRECTORIES_USER = $stationPreviousUser
}
