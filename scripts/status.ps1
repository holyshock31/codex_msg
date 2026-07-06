param(
  [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $InstallRoot = (Resolve-Path $InstallRoot).Path
}

$viewerPort = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
$ingestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
$cliPath = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
$configPath = [Environment]::GetEnvironmentVariable("CODEX_TRACE_WRAPPER_CONFIG", "User")

$viewerConnections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $viewerPort -State Listen -ErrorAction SilentlyContinue
$ingestConnections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $ingestPort -State Listen -ErrorAction SilentlyContinue

[pscustomobject]@{
  InstallRoot = $InstallRoot
  User_CODEX_CLI_PATH = $cliPath
  User_CODEX_CLI_PATH_Exists = if ([string]::IsNullOrWhiteSpace($cliPath)) { $false } else { Test-Path -Path $cliPath -PathType Leaf }
  User_CODEX_TRACE_WRAPPER_CONFIG = $configPath
  User_CODEX_TRACE_WRAPPER_CONFIG_Exists = if ([string]::IsNullOrWhiteSpace($configPath)) { $false } else { Test-Path -Path $configPath -PathType Leaf }
  ViewerUrl = "http://127.0.0.1:$viewerPort/?v=chat-redesign"
  ViewerListening = [bool]$viewerConnections
  ViewerProcessIds = (($viewerConnections | Select-Object -ExpandProperty OwningProcess -Unique) -join ",")
  IngestUrl = "tcp://127.0.0.1:$ingestPort"
  IngestListening = [bool]$ingestConnections
  IngestProcessIds = (($ingestConnections | Select-Object -ExpandProperty OwningProcess -Unique) -join ",")
} | Format-List
