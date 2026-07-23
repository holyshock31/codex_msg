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
$ViewerRoot = Join-Path $Root "codex-trace-viewer"

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
Copy-Item -Path (Join-Path $Root "PRIVACY.md") -Destination (Join-Path $PackageRoot "PRIVACY.md") -Force
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
$PackageViewerRoot = Join-Path $PackageRoot "codex-trace-viewer"
$viewerFiles = @("server.js", "text-encoding.js", "package.json", "package-lock.json")
foreach ($viewerFile in $viewerFiles) {
  $source = Join-Path $ViewerRoot $viewerFile
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Viewer release file not found: $source"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $PackageViewerRoot $viewerFile) -Force
}

$viewerDependency = Join-Path $ViewerRoot "node_modules\iconv-lite\package.json"
if (-not (Test-Path -LiteralPath $viewerDependency -PathType Leaf)) {
  throw "Viewer production dependencies are missing. Run 'npm ci --omit=dev --ignore-scripts' in codex-trace-viewer before packaging."
}

Copy-Item -Path (Join-Path $ViewerRoot "public") -Destination (Join-Path $PackageViewerRoot "public") -Recurse -Force
Copy-Item -Path (Join-Path $ViewerRoot "scripts") -Destination (Join-Path $PackageViewerRoot "scripts") -Recurse -Force
Copy-Item -Path (Join-Path $ViewerRoot "node_modules") -Destination (Join-Path $PackageViewerRoot "node_modules") -Recurse -Force

if (Test-Path -Path $ZipPath) {
  Remove-Item -Path $ZipPath -Force
}
Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -Force

Write-Host "Release package created:"
Write-Host $ZipPath
Write-Host "Install root expected on target machines:"
Write-Host "%USERPROFILE%\Documents\CodexTrace"
