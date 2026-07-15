param(
  [switch]$SkipBuild,
  [string]$PackageName = "CodexTrace"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DistRoot = Join-Path $Root "dist"
$PackageRoot = Join-Path $DistRoot $PackageName
$ZipPath = Join-Path $DistRoot "$PackageName.zip"
$WrapperProject = Join-Path $Root "codex-trace-wrapper"
$WrapperExe = Join-Path $WrapperProject "dist\codex-trace-wrapper.exe"

if (-not $SkipBuild) {
  & (Join-Path $WrapperProject "scripts\build-release.ps1")
}

if (-not (Test-Path -Path $WrapperExe -PathType Leaf)) {
  throw "Wrapper executable not found: $WrapperExe"
}

New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null

$resolvedDist = (Resolve-Path $DistRoot).Path.TrimEnd('\')
$packageFull = [System.IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
if (-not $packageFull.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean package path outside dist: $PackageRoot"
}

if (Test-Path -Path $PackageRoot) {
  Remove-Item -Path $PackageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null

Copy-Item -Path (Join-Path $Root "install.ps1") -Destination (Join-Path $PackageRoot "install.ps1") -Force
Copy-Item -Path (Join-Path $Root "LICENSE") -Destination (Join-Path $PackageRoot "LICENSE") -Force
Copy-Item -Path (Join-Path $Root "codex-trace.ps1") -Destination (Join-Path $PackageRoot "codex-trace.ps1") -Force
Copy-Item -Path (Join-Path $Root "start.ps1") -Destination (Join-Path $PackageRoot "start.ps1") -Force
Copy-Item -Path (Join-Path $Root "stop.ps1") -Destination (Join-Path $PackageRoot "stop.ps1") -Force
Copy-Item -Path (Join-Path $Root "status.ps1") -Destination (Join-Path $PackageRoot "status.ps1") -Force
Copy-Item -Path (Join-Path $Root "enable-desktop-trace.ps1") -Destination (Join-Path $PackageRoot "enable-desktop-trace.ps1") -Force
Copy-Item -Path (Join-Path $Root "disable-desktop-trace.ps1") -Destination (Join-Path $PackageRoot "disable-desktop-trace.ps1") -Force
Copy-Item -Path (Join-Path $Root "docs\distribution-user-guide.md") -Destination (Join-Path $PackageRoot "README.md") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot "bin") | Out-Null
Copy-Item -Path $WrapperExe -Destination (Join-Path $PackageRoot "bin\codex-trace-wrapper.exe") -Force
Copy-Item -Path (Join-Path $Root "tools\release-config.toml") -Destination (Join-Path $PackageRoot "bin\config.toml") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot "scripts") | Out-Null
Copy-Item -Path (Join-Path $Root "scripts\enable-desktop-trace.ps1") -Destination (Join-Path $PackageRoot "scripts\enable-desktop-trace.ps1") -Force
Copy-Item -Path (Join-Path $Root "scripts\disable-desktop-trace.ps1") -Destination (Join-Path $PackageRoot "scripts\disable-desktop-trace.ps1") -Force
Copy-Item -Path (Join-Path $Root "scripts\start-viewer.ps1") -Destination (Join-Path $PackageRoot "scripts\start-viewer.ps1") -Force
Copy-Item -Path (Join-Path $Root "scripts\stop-viewer.ps1") -Destination (Join-Path $PackageRoot "scripts\stop-viewer.ps1") -Force
Copy-Item -Path (Join-Path $Root "scripts\status.ps1") -Destination (Join-Path $PackageRoot "scripts\status.ps1") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot "docs") | Out-Null
Copy-Item -Path (Join-Path $Root "docs\distribution-user-guide.md") -Destination (Join-Path $PackageRoot "docs\distribution-user-guide.md") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot "codex-trace-wrapper") | Out-Null
Copy-Item -Path (Join-Path $Root "tools\release-config.toml") -Destination (Join-Path $PackageRoot "codex-trace-wrapper\config.toml") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot "codex-trace-viewer") | Out-Null
Copy-Item -Path (Join-Path $Root "codex-trace-viewer\server.js") -Destination (Join-Path $PackageRoot "codex-trace-viewer\server.js") -Force
Copy-Item -Path (Join-Path $Root "codex-trace-viewer\package.json") -Destination (Join-Path $PackageRoot "codex-trace-viewer\package.json") -Force
Copy-Item -Path (Join-Path $Root "codex-trace-viewer\public") -Destination (Join-Path $PackageRoot "codex-trace-viewer\public") -Recurse -Force
Copy-Item -Path (Join-Path $Root "codex-trace-viewer\scripts") -Destination (Join-Path $PackageRoot "codex-trace-viewer\scripts") -Recurse -Force

if (Test-Path -Path $ZipPath) {
  Remove-Item -Path $ZipPath -Force
}
Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -Force

Write-Host "Release package created:"
Write-Host $ZipPath
Write-Host "Install root expected on target machines:"
Write-Host "%USERPROFILE%\Documents\CodexTrace"
