param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^COM[1-9][0-9]{0,2}$')]
  [string]$Port
)

$ErrorActionPreference = 'Stop'
$stationEncoding = [System.Text.UTF8Encoding]::new($false, $true)
$stationSerialEncoding = [System.Text.UTF8Encoding]::new($false, $false)
[Console]::InputEncoding = $stationEncoding
[Console]::OutputEncoding = $stationEncoding
$OutputEncoding = $stationEncoding
$stationSerial = [System.IO.Ports.SerialPort]::new($Port, 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$stationSerial.Handshake = [System.IO.Ports.Handshake]::None
# ESP boot-ROM chatter uses a different baud and can contain invalid UTF-8.
# Replace those bytes; the Node schema parser ignores the resulting non-JSON
# lines. Strict command input stays separate from this tolerant serial reader.
$stationSerial.Encoding = $stationSerialEncoding
$stationSerial.NewLine = "`n"
$stationSerial.ReadTimeout = 100
$stationSerial.WriteTimeout = 1500
# Do not request the NodeMCU auto-reset/boot signals when opening its USB port.
$stationSerial.DtrEnable = $false
$stationSerial.RtsEnable = $false
$stationInputStream = [Console]::OpenStandardInput()
$stationInputReader = [System.IO.StreamReader]::new($stationInputStream, $stationEncoding, $false, 4096, $true)

try {
  $stationSerial.Open()
  # Console.In is a synchronized TextReader whose ReadLineAsync can execute
  # synchronously. A StreamReader over the redirected pipe keeps serial ACK
  # polling alive even while the parent has no new command to send.
  $stationInput = $stationInputReader.ReadLineAsync()
  while ($true) {
    if ($stationInput.IsCompleted) {
      $stationCommand = $stationInput.GetAwaiter().GetResult()
      if ($null -eq $stationCommand) { break }
      if ($stationEncoding.GetByteCount($stationCommand) -gt 384 -or $stationCommand.Contains("`r") -or $stationCommand.Contains("`n")) { throw 'Invalid station command size.' }
      $stationSerial.WriteLine($stationCommand)
      $stationInput = $stationInputReader.ReadLineAsync()
    }
    $stationOutput = $stationSerial.ReadExisting()
    if ($stationOutput.Length -gt 0) {
      [Console]::Out.Write($stationOutput)
      [Console]::Out.Flush()
    }
    Start-Sleep -Milliseconds 50
  }
} catch {
  [Console]::Error.WriteLine('Station USB port failed. Close Arduino Serial Monitor and check the selected COM port. No payments were changed.')
  exit 1
} finally {
  if ($stationSerial.IsOpen) { $stationSerial.Close() }
  $stationSerial.Dispose()
  $stationInputReader.Dispose()
  $stationInputStream.Dispose()
}
