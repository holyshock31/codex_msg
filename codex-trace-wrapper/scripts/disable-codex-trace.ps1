param(
  [switch]$Broadcast
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "env-user.ps1")

Remove-CodexTraceUserEnv -Name "CODEX_CLI_PATH"
Remove-CodexTraceUserEnv -Name "CODEX_TRACE_WRAPPER_CONFIG"
if ($Broadcast) {
  Send-CodexTraceEnvironmentChanged
}

Write-Host "Disabled Codex trace wrapper for future Codex Desktop launches."
Write-Host "Restart Codex Desktop to return to the native bundled CLI path."
if (-not $Broadcast) {
  Write-Host "Environment broadcast skipped to avoid hangs. This is OK if you restart Codex Desktop."
}
