param(
  [switch]$Broadcast
)

$ErrorActionPreference = "Stop"

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

Remove-CodexTraceUserEnv -Name "CODEX_CLI_PATH"
Remove-CodexTraceUserEnv -Name "CODEX_TRACE_WRAPPER_CONFIG"

if ($Broadcast) {
  Send-CodexTraceEnvironmentChanged
}

Write-Host "Disabled Codex Desktop trace for future launches."
Write-Host "Restart Codex Desktop to return to the native bundled CLI path."
if (-not $Broadcast) {
  Write-Host "Environment broadcast skipped to avoid hangs. This is OK if you restart Codex Desktop."
}
