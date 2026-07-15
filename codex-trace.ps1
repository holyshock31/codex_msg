param(
  [Parameter(Position = 0)]
  [string]$Command = "start",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs = @()
)

$ErrorActionPreference = "Stop"
$validCommands = @("install", "setup", "start", "stop", "restart", "status", "enable", "disable", "test-storage", "help")
$InstallRoot = ""
$ConfigPath = ""
$EnableDesktopTrace = $false
$Broadcast = $false
$NoEnable = $false
$NoStartViewer = $false

if ($Command.StartsWith("-")) {
  $RemainingArgs = @($Command) + @($RemainingArgs)
  $Command = "start"
}

if ($validCommands -notcontains $Command) {
  throw "Unknown command '$Command'. Run .\codex-trace.ps1 help."
}

for ($index = 0; $index -lt $RemainingArgs.Count; $index += 1) {
  $arg = $RemainingArgs[$index]
  switch -Regex ($arg) {
    "^-InstallRoot[:=](.+)$" {
      $InstallRoot = $Matches[1]
      break
    }
    "^-InstallRoot$" {
      $index += 1
      if ($index -ge $RemainingArgs.Count) {
        throw "-InstallRoot requires a path."
      }
      $InstallRoot = $RemainingArgs[$index]
      break
    }
    "^-ConfigPath[:=](.+)$" {
      $ConfigPath = $Matches[1]
      break
    }
    "^-ConfigPath$" {
      $index += 1
      if ($index -ge $RemainingArgs.Count) {
        throw "-ConfigPath requires a path."
      }
      $ConfigPath = $RemainingArgs[$index]
      break
    }
    "^-EnableDesktopTrace$" {
      $EnableDesktopTrace = $true
      break
    }
    "^-Broadcast$" {
      $Broadcast = $true
      break
    }
    "^-NoEnable$" {
      $NoEnable = $true
      break
    }
    "^-NoStartViewer$" {
      $NoStartViewer = $true
      break
    }
    default {
      throw "Unknown argument '$arg'. Run .\codex-trace.ps1 help."
    }
  }
}

function Resolve-CodexTraceInstallRoot {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return (Resolve-Path $PSScriptRoot).Path
  }

  return [System.IO.Path]::GetFullPath($Value)
}

function Get-CodexTracePort {
  param(
    [string]$Name,
    [int]$Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return [int]$value
}

function Resolve-CodexTraceScript {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $script = Join-Path $script:InstallRoot $RelativePath
  if (-not (Test-Path -Path $script -PathType Leaf)) {
    throw "Script not found: $script"
  }

  return $script
}

function Invoke-CodexTraceInstall {
  $installScript = Join-Path $PSScriptRoot "install.ps1"
  if (-not (Test-Path -Path $installScript -PathType Leaf)) {
    throw "Install script not found: $installScript"
  }

  $installParams = @{}
  if (-not [string]::IsNullOrWhiteSpace($script:RequestedInstallRoot)) {
    $installParams["InstallRoot"] = $script:RequestedInstallRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($script:RequestedConfigPath)) {
    $installParams["ConfigPath"] = $script:RequestedConfigPath
  }
  if ($NoEnable) {
    $installParams["NoEnable"] = $true
  }
  if ($NoStartViewer) {
    $installParams["NoStartViewer"] = $true
  }

  & $installScript @installParams
}

function Get-CodexTraceListeningProcessIds {
  param([int]$Port)

  $connections = Get-NetTCPConnection `
    -LocalAddress 127.0.0.1 `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue

  return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Format-CodexTraceBytes {
  param([object]$Bytes)

  if ($null -eq $Bytes) {
    return "n/a"
  }

  $value = [double]$Bytes
  $units = @("B", "KB", "MB", "GB", "TB")
  $index = 0
  while ($value -ge 1024 -and $index -lt ($units.Length - 1)) {
    $value = $value / 1024
    $index += 1
  }

  if ($index -eq 0) {
    return ("{0:N0} {1}" -f $value, $units[$index])
  }

  return ("{0:N1} {1}" -f $value, $units[$index])
}

function Format-CodexTraceTimestamp {
  param([object]$Milliseconds)

  if ($null -eq $Milliseconds -or [int64]$Milliseconds -le 0) {
    return "never"
  }

  return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Milliseconds).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")
}

function Show-CodexTraceStorageStatus {
  param([int]$ViewerPort)

  $viewerPids = Get-CodexTraceListeningProcessIds -Port $ViewerPort
  Write-Host ""
  Write-Host "Storage:"
  if ($viewerPids.Count -eq 0) {
    Write-Host "  Viewer is not running. Review storage starts and stops with the viewer."
    return
  }

  try {
    $uri = "http://127.0.0.1:$ViewerPort/api/storage?force=1"
    $storage = Invoke-RestMethod -Method GET -Uri $uri -TimeoutSec 3
    Write-Host ("  Enabled: {0}" -f $storage.enabled)
    Write-Host ("  Directory: {0}" -f $storage.storageDir)
    Write-Host ("  Size: {0} across {1} segment(s)" -f (Format-CodexTraceBytes $storage.sizeBytes), $storage.segmentCount)
    Write-Host ("  Pending: {0} event(s), {1}" -f $storage.pendingEvents, (Format-CodexTraceBytes $storage.pendingBytes))
    Write-Host ("  Written: {0} event(s), {1}" -f $storage.writtenEvents, (Format-CodexTraceBytes $storage.writtenBytes))
    Write-Host ("  Last flush: {0}" -f (Format-CodexTraceTimestamp $storage.lastFlushTs))
    if (-not [string]::IsNullOrWhiteSpace($storage.lastError)) {
      Write-Host ("  Last error: {0}" -f $storage.lastError)
    }
  } catch {
    Write-Host ("  Failed to read storage status: {0}" -f $_.Exception.Message)
  }
}

function Start-CodexTrace {
  param(
    [int]$ViewerPort,
    [switch]$EnableDesktopTrace,
    [switch]$Broadcast
  )

  if ($EnableDesktopTrace) {
    & (Resolve-CodexTraceScript "scripts\enable-desktop-trace.ps1") -InstallRoot $script:InstallRoot -Broadcast:$Broadcast
    Write-Host ""
  }

  $viewerPids = Get-CodexTraceListeningProcessIds -Port $ViewerPort
  if ($viewerPids.Count -gt 0) {
    Write-Host "Codex trace viewer is already running."
    Write-Host "URL: http://127.0.0.1:$ViewerPort/?v=chat-redesign"
    Write-Host ("PID(s): {0}" -f ($viewerPids -join ","))
    Show-CodexTraceStorageStatus -ViewerPort $ViewerPort
    return
  }

  & (Resolve-CodexTraceScript "scripts\start-viewer.ps1") -InstallRoot $script:InstallRoot
  Show-CodexTraceStorageStatus -ViewerPort $ViewerPort
}

function Stop-CodexTrace {
  & (Resolve-CodexTraceScript "scripts\stop-viewer.ps1") -InstallRoot $script:InstallRoot
  Write-Host "Review storage stopped with the viewer."
}

function Show-CodexTraceStatus {
  param([int]$ViewerPort)

  & (Resolve-CodexTraceScript "scripts\status.ps1") -InstallRoot $script:InstallRoot
  Show-CodexTraceStorageStatus -ViewerPort $ViewerPort
}

function Show-CodexTraceHelp {
  Write-Host "Usage:"
  Write-Host "  .\codex-trace.ps1 install [-InstallRoot <path>] [-ConfigPath <path>] [-NoEnable] [-NoStartViewer]"
  Write-Host "  .\codex-trace.ps1 setup [-InstallRoot <path>] [-ConfigPath <path>] [-NoEnable] [-NoStartViewer]"
  Write-Host "  .\codex-trace.ps1 start [-EnableDesktopTrace] [-Broadcast]"
  Write-Host "  .\codex-trace.ps1 status"
  Write-Host "  .\codex-trace.ps1 stop"
  Write-Host "  .\codex-trace.ps1 restart"
  Write-Host "  .\codex-trace.ps1 enable [-Broadcast]"
  Write-Host "  .\codex-trace.ps1 disable [-Broadcast]"
  Write-Host "  .\codex-trace.ps1 test-storage"
  Write-Host ""
  Write-Host "Use install/setup for copy + Desktop env + viewer start. Use start for daily viewer startup only."
  Write-Host "Component scripts under scripts/ and codex-trace-viewer/scripts/ are kept for debugging."
}

$script:RequestedInstallRoot = $InstallRoot
$script:RequestedConfigPath = $ConfigPath
$script:InstallRoot = Resolve-CodexTraceInstallRoot -Value $InstallRoot
$viewerPort = Get-CodexTracePort -Name "CODEX_TRACE_VIEWER_PORT" -Default 45123

switch ($Command) {
  "install" {
    Invoke-CodexTraceInstall
    break
  }
  "setup" {
    Invoke-CodexTraceInstall
    break
  }
  "start" {
    Start-CodexTrace -ViewerPort $viewerPort -EnableDesktopTrace:$EnableDesktopTrace -Broadcast:$Broadcast
    break
  }
  "stop" {
    Stop-CodexTrace
    break
  }
  "restart" {
    Stop-CodexTrace
    Start-CodexTrace -ViewerPort $viewerPort -EnableDesktopTrace:$EnableDesktopTrace -Broadcast:$Broadcast
    break
  }
  "status" {
    Show-CodexTraceStatus -ViewerPort $viewerPort
    break
  }
  "enable" {
    & (Resolve-CodexTraceScript "scripts\enable-desktop-trace.ps1") -InstallRoot $script:InstallRoot -Broadcast:$Broadcast
    break
  }
  "disable" {
    & (Resolve-CodexTraceScript "scripts\disable-desktop-trace.ps1") -Broadcast:$Broadcast
    break
  }
  "test-storage" {
    & (Resolve-CodexTraceScript "codex-trace-viewer\scripts\test-storage.ps1")
    break
  }
  "help" {
    Show-CodexTraceHelp
    break
  }
}
