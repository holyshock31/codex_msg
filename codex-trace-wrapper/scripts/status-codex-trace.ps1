$ErrorActionPreference = "Stop"

$userCliPath = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
$processCliPath = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "Process")
$userConfigPath = [Environment]::GetEnvironmentVariable("CODEX_TRACE_WRAPPER_CONFIG", "User")
$processConfigPath = [Environment]::GetEnvironmentVariable("CODEX_TRACE_WRAPPER_CONFIG", "Process")

[pscustomobject]@{
  User_CODEX_CLI_PATH = $userCliPath
  Process_CODEX_CLI_PATH = $processCliPath
  User_CODEX_TRACE_WRAPPER_CONFIG = $userConfigPath
  Process_CODEX_TRACE_WRAPPER_CONFIG = $processConfigPath
  User_CLI_Path_Exists = if ([string]::IsNullOrWhiteSpace($userCliPath)) { $false } else { Test-Path -LiteralPath $userCliPath -PathType Leaf }
  User_Config_Path_Exists = if ([string]::IsNullOrWhiteSpace($userConfigPath)) { $false } else { Test-Path -LiteralPath $userConfigPath -PathType Leaf }
} | Format-List
