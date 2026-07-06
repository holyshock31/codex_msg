$ErrorActionPreference = "Stop"

Push-Location (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
try {
  New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
  go build -trimpath -ldflags="-s -w" -o ".\dist\codex-trace-wrapper.exe" ".\cmd\codex-trace-wrapper"
  go build -trimpath -ldflags="-s -w" -o ".\dist\codex-proxy-trace.exe" ".\cmd\codex-proxy-trace"

  $env:GOOS = "linux"
  $env:GOARCH = "amd64"
  try {
    go build -trimpath -ldflags="-s -w" -o ".\dist\codex-proxy-trace-linux-amd64" ".\cmd\codex-proxy-trace"
  } finally {
    Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
