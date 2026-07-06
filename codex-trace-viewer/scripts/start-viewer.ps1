$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Port = if ($env:CODEX_TRACE_VIEWER_PORT) { $env:CODEX_TRACE_VIEWER_PORT } else { "45123" }
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "viewer.pid"
$StdoutLog = Join-Path $LogDir "viewer.out.log"
$StderrLog = Join-Path $LogDir "viewer.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  throw "Port 127.0.0.1:$Port is already in use by process $($existing.OwningProcess | Select-Object -Unique)"
}

$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $node `
  -ArgumentList @("server.js") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
Start-Sleep -Milliseconds 800

Write-Host "Codex trace viewer started."
Write-Host "URL: http://127.0.0.1:$Port"
Write-Host "PID: $($process.Id)"
Write-Host "Stdout log: $StdoutLog"
Write-Host "Stderr log: $StderrLog"
