param(
  [string]$WrapperPath = "",
  [string]$ConfigPath = "",
  [switch]$Broadcast
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "env-user.ps1")

if ([string]::IsNullOrWhiteSpace($WrapperPath)) {
  $WrapperPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "dist\codex-trace-wrapper.exe"
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "config.toml"
}

if (-not (Test-Path -LiteralPath $WrapperPath -PathType Leaf)) {
  throw "Wrapper executable not found: $WrapperPath"
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Config file not found: $ConfigPath"
}

Set-CodexTraceUserEnv -Name "CODEX_CLI_PATH" -Value $WrapperPath
Set-CodexTraceUserEnv -Name "CODEX_TRACE_WRAPPER_CONFIG" -Value $ConfigPath
if ($Broadcast) {
  Send-CodexTraceEnvironmentChanged
}

Write-Host "Enabled Codex trace wrapper for future Codex Desktop launches."
Write-Host "CODEX_CLI_PATH=$WrapperPath"
Write-Host "CODEX_TRACE_WRAPPER_CONFIG=$ConfigPath"
Write-Host "Restart Codex Desktop for the change to take effect."
if (-not $Broadcast) {
  Write-Host "Environment broadcast skipped to avoid hangs. This is OK if you restart Codex Desktop."
}
