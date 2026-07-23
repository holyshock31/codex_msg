$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Port = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
$IngestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "viewer.pid"
$StdoutLog = Join-Path $LogDir "viewer.out.log"
$StderrLog = Join-Path $LogDir "viewer.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

foreach ($requiredPort in @($Port, $IngestPort)) {
  $existing = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $requiredPort -State Listen -ErrorAction SilentlyContinue)
  if ($existing.Count -eq 0) { continue }
  $owners = @($existing | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    $owner = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($owner) { "PID $_ ($($owner.ProcessName))" } else { "PID $_" }
  })
  throw "Port 127.0.0.1:$requiredPort is already in use by $($owners -join ', '). The viewer requires both ports $Port and $IngestPort."
}

$bundledNode = Join-Path (Resolve-Path (Join-Path $Root "..")) "runtime\node.exe"
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
  $node = $bundledNode
} else {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw "Node.js 20 or newer is required to run the viewer."
  }
  $node = $nodeCommand.Source
}

$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.' -or [int]$Matches.major -lt 20) {
  throw "Node.js 20 or newer is required to run the viewer. Found: $nodeVersion"
}

$process = Start-Process -FilePath $node `
  -ArgumentList @("server.js") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII

$healthy = $false
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) { break }
  $viewerListener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $process.Id }
  $ingestListener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $IngestPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $process.Id }
  if ($viewerListener -and $ingestListener) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {
      # The listeners can become visible just before the HTTP endpoint is ready.
    }
  }
  Start-Sleep -Milliseconds 200
}

if (-not $healthy) {
  $process.Refresh()
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  $stderrTail = if (Test-Path -LiteralPath $StderrLog -PathType Leaf) {
    (Get-Content -LiteralPath $StderrLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
  } else {
    ""
  }
  $detail = if ($stderrTail) { "`n$stderrTail" } else { "" }
  throw "Codex trace viewer failed to become healthy within 8 seconds.$detail"
}

Write-Host "Codex trace viewer started."
Write-Host "URL: http://127.0.0.1:$Port"
Write-Host "PID: $($process.Id)"
Write-Host "Stdout log: $StdoutLog"
Write-Host "Stderr log: $StderrLog"
