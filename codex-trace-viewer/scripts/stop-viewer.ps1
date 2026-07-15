$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root "logs\viewer.pid"
$ViewerPort = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
$IngestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
  $listeners = @(foreach ($port in @($ViewerPort, $IngestPort)) {
    Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  })
  if ($listeners.Count -gt 0) {
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    throw "Viewer pid file is missing, but the trace ports are in use by process(es): $($owners -join ', '). Refusing to stop an unverified process."
  }
  Write-Host "No viewer process found."
  exit 0
}

$pidValue = (Get-Content -LiteralPath $PidFile -Raw).Trim()
if ($pidValue -notmatch '^\d+$') {
  throw "Viewer pid file is invalid: $PidFile"
}

$processId = [int]$pidValue
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  Write-Host "Removed stale viewer pid file for process $processId."
  exit 0
}
if ($process.ProcessName -ne "node") {
  throw "PID $processId belongs to $($process.ProcessName), not Node.js. Refusing to stop it."
}

$ownedListeners = @(foreach ($port in @($ViewerPort, $IngestPort)) {
  Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $processId }
})
if ($ownedListeners.Count -eq 0) {
  throw "PID $processId does not own the configured trace ports. Refusing to stop it."
}

Stop-Process -Id $processId -Force -ErrorAction Stop
Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
Write-Host "Stopped viewer process $processId ($($process.ProcessName))."
