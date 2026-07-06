$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root "logs\viewer.pid"
$ViewerPort = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
$IngestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
$processIds = @()

if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
  $pidValue = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($pidValue -match '^\d+$') {
    $processIds += [int]$pidValue
  }
}

foreach ($port in @($ViewerPort, $IngestPort)) {
  $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -and $connection.OwningProcess -ne 0) {
      $processIds += [int]$connection.OwningProcess
    }
  }
}

$processIds = @($processIds | Select-Object -Unique)
if ($processIds.Count -eq 0) {
  if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  } else {
    Write-Host "No viewer pid file found."
  }
  Write-Host "No viewer process found on 127.0.0.1:$ViewerPort or 127.0.0.1:$IngestPort."
  exit 0
}

foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    continue
  }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped viewer process $processId ($($process.ProcessName))."
}

Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
