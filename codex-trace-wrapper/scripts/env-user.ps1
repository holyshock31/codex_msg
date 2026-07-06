$EnvRegistryPath = "HKCU:\Environment"

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

  $persisted = (Get-ItemProperty -Path $EnvRegistryPath -Name $Name -ErrorAction Stop).$Name
  if ($persisted -ne $Value) {
    throw "Failed to persist user environment variable $Name. Expected '$Value', got '$persisted'."
  }
}

function Remove-CodexTraceUserEnv {
  param(
    [Parameter(Mandatory = $true)][string]$Name
  )

  & reg.exe delete "HKCU\Environment" /v $Name /f 2>$null | Out-Null
  Remove-Item -Path "Env:\$Name" -ErrorAction SilentlyContinue
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

  $hwndBroadcast = [IntPtr]0xffff
  $wmSettingChange = 0x001A
  $smtoAbortIfHung = 0x0002
  $timeoutMs = 2000
  $result = [IntPtr]::Zero
  [void][CodexTrace.NativeEnvBroadcast]::SendMessageTimeout(
    $hwndBroadcast,
    $wmSettingChange,
    [IntPtr]::Zero,
    "Environment",
    $smtoAbortIfHung,
    $timeoutMs,
    [ref]$result)
}
