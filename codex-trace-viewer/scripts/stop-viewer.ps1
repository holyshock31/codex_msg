$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root "logs\viewer.pid"

if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
  Write-Host "No viewer pid file found."
  exit 0
}

$pidValue = (Get-Content -LiteralPath $PidFile -Raw).Trim()
if ($pidValue -match '^\d+$') {
  Stop-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  Write-Host "Stopped viewer process $pidValue."
}

Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
