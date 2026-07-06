param(
  [string]$InstallRoot = "",
  [switch]$Broadcast
)

$ErrorActionPreference = "Stop"

function Set-CodexTraceUserEnv {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $regResult = & reg.exe add "HKCU\Environment" /v $Name /t REG_SZ /d $Value /f 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to write user environment variable $Name via reg.exe: $regResult"
  }
  Set-Item -Path "Env:\$Name" -Value $Value
}

function Send-CodexTraceEnvironmentChanged {
  $typeName = "CodexTrace.NativeEnvBroadcast"
  if (-not ($typeName -as [type])) {
    Add-Type -TypeDefinition @"
namespace CodexTrace {
  using System;
  using System.Runtime.InteropServices;

  public static class NativeEnvBroadcast {
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd,
      uint Msg,
      IntPtr wParam,
      string lParam,
      uint fuFlags,
      uint uTimeout,
      out IntPtr lpdwResult);
  }
}
"@ | Out-Null
  }

  $result = [IntPtr]::Zero
  [void][CodexTrace.NativeEnvBroadcast]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x001A,
    [IntPtr]::Zero,
    "Environment",
    0x0002,
    2000,
    [ref]$result)
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $InstallRoot = (Resolve-Path $InstallRoot).Path
}

$wrapperPath = Join-Path $InstallRoot "bin\codex-trace-wrapper.exe"
$configPath = Join-Path $InstallRoot "codex-trace-wrapper\config.toml"

if (-not (Test-Path -Path $wrapperPath -PathType Leaf)) {
  throw "Wrapper executable not found: $wrapperPath"
}
if (-not (Test-Path -Path $configPath -PathType Leaf)) {
  throw "Wrapper config not found: $configPath"
}

Set-CodexTraceUserEnv -Name "CODEX_CLI_PATH" -Value $wrapperPath
Set-CodexTraceUserEnv -Name "CODEX_TRACE_WRAPPER_CONFIG" -Value $configPath

if ($Broadcast) {
  Send-CodexTraceEnvironmentChanged
}

Write-Host "Enabled Codex Desktop trace for future launches."
Write-Host "CODEX_CLI_PATH=$wrapperPath"
Write-Host "CODEX_TRACE_WRAPPER_CONFIG=$configPath"
Write-Host "Restart Codex Desktop for the change to take effect."
if (-not $Broadcast) {
  Write-Host "Environment broadcast skipped to avoid hangs. This is OK if you restart Codex Desktop."
}
