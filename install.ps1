param(
  [string]$InstallRoot = "",
  [switch]$NoEnable,
  [switch]$NoStartViewer
)

$ErrorActionPreference = "Stop"

function Copy-CodexTraceItem {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -Path $Source)) {
    throw "Package item not found: $Source"
  }

  if ((Test-Path -Path $Source -PathType Container) -and (Test-Path -Path $Destination)) {
    $resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if (-not $resolvedDestination.StartsWith($resolvedInstall, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to replace destination outside install root: $Destination"
    }
    Remove-Item -Path $Destination -Recurse -Force
  }

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -Path $Source -Destination $Destination -Recurse -Force
}

$SourceRoot = (Resolve-Path $PSScriptRoot).Path
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:USERPROFILE "Documents\CodexTrace"
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$defaultRoot = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Documents\CodexTrace"))
$defaultRootLabel = "%USERPROFILE%\Documents\CodexTrace"

if ($InstallRoot -ne $defaultRoot) {
  Write-Warning "The default install path is: $defaultRootLabel"
  Write-Warning "A custom path may be restricted by Windows or organization security policy."
}

if (-not (Test-Path -Path (Join-Path $SourceRoot "bin\codex-trace-wrapper.exe") -PathType Leaf)) {
  throw "This package is missing bin\codex-trace-wrapper.exe. Build the release package again."
}

$sameRoot = [string]::Equals($SourceRoot.TrimEnd('\'), $InstallRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
if (-not $sameRoot) {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "bin") -Destination (Join-Path $InstallRoot "bin")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace-viewer") -Destination (Join-Path $InstallRoot "codex-trace-viewer")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace-wrapper") -Destination (Join-Path $InstallRoot "codex-trace-wrapper")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "scripts") -Destination (Join-Path $InstallRoot "scripts")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "docs") -Destination (Join-Path $InstallRoot "docs")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "README.md") -Destination (Join-Path $InstallRoot "README.md")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "install.ps1") -Destination (Join-Path $InstallRoot "install.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "start.ps1") -Destination (Join-Path $InstallRoot "start.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "stop.ps1") -Destination (Join-Path $InstallRoot "stop.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "status.ps1") -Destination (Join-Path $InstallRoot "status.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "enable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "enable-desktop-trace.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "disable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "disable-desktop-trace.ps1")
}

$wrapperPath = Join-Path $InstallRoot "bin\codex-trace-wrapper.exe"
$configPath = Join-Path $InstallRoot "codex-trace-wrapper\config.toml"
$viewerScript = Join-Path $InstallRoot "scripts\start-viewer.ps1"
$enableScript = Join-Path $InstallRoot "scripts\enable-desktop-trace.ps1"

if (-not (Test-Path -Path $wrapperPath -PathType Leaf)) {
  throw "Wrapper executable not installed: $wrapperPath"
}
if (-not (Test-Path -Path $configPath -PathType Leaf)) {
  throw "Wrapper config not installed: $configPath"
}

if (-not $NoEnable) {
  & $enableScript -InstallRoot $InstallRoot
}

if (-not $NoStartViewer) {
  & $viewerScript -InstallRoot $InstallRoot
}

Write-Host ""
Write-Host "Codex Trace installed at: $InstallRoot"
Write-Host "Viewer URL: http://127.0.0.1:45123/?v=chat-redesign"
Write-Host "Restart Codex Desktop after first install or after re-enabling trace."
