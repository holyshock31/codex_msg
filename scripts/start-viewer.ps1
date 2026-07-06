param(
  [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $InstallRoot = (Resolve-Path $InstallRoot).Path
}

$script = Join-Path $InstallRoot "codex-trace-viewer\scripts\start-viewer.ps1"
if (-not (Test-Path -Path $script -PathType Leaf)) {
  throw "Viewer start script not found: $script"
}

& $script
