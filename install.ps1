param(
  [string]$InstallRoot = "",
  [string]$ConfigPath = "",
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

function Assert-CodexTraceInstallDestination {
  param([Parameter(Mandatory = $true)][string]$Destination)

  $resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $resolvedDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
  $installPrefix = "$resolvedInstall\"
  if (
    -not $resolvedDestination.Equals($resolvedInstall, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $resolvedDestination.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to replace destination outside install root: $Destination"
  }
}

function Copy-CodexTraceDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$PreserveTopLevelNames = @()
  )

  if (-not (Test-Path -Path $Source -PathType Container)) {
    throw "Package directory not found: $Source"
  }

  Assert-CodexTraceInstallDestination -Destination $Destination
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  $preserve = @{}
  foreach ($name in $PreserveTopLevelNames) {
    $preserve[$name.ToLowerInvariant()] = $true
  }

  foreach ($item in Get-ChildItem -LiteralPath $Destination -Force) {
    if ($preserve.ContainsKey($item.Name.ToLowerInvariant())) {
      continue
    }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  }

  foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
    if ($preserve.ContainsKey($item.Name.ToLowerInvariant())) {
      continue
    }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Recurse -Force
  }
}

function Copy-CodexTraceFileIfChanged {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Label = ""
  )

  if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = Split-Path -Leaf $Destination
  }
  if (-not (Test-Path -Path $Source -PathType Leaf)) {
    throw "Package file not found: $Source"
  }

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  if (Test-Path -Path $Destination -PathType Leaf) {
    try {
      $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
      $destinationHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
      if ($sourceHash -eq $destinationHash) {
        Write-Host "$Label is already up to date."
        return
      }
    } catch {
      Write-Warning "Could not compare $Label before copying: $($_.Exception.Message)"
    }
  }

  try {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
    Write-Host "Updated $Label."
  } catch {
    throw "Cannot update $Label at $Destination. If Codex Desktop is running, quit Codex Desktop and rerun .\codex-trace.ps1 install. Original error: $($_.Exception.Message)"
  }
}

function Stop-CodexTraceViewer {
  param([Parameter(Mandatory = $true)][string]$Root)

  $viewerRoot = Join-Path $Root "codex-trace-viewer"
  $pidFile = Join-Path $viewerRoot "logs\viewer.pid"
  $viewerPort = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
  $ingestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
  if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    $listeners = @(foreach ($port in @($viewerPort, $ingestPort)) {
      Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    })
    if ($listeners.Count -gt 0) {
      $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
      throw "Viewer pid file is missing under $Root, but the trace ports are in use by process(es): $($owners -join ', '). Refusing to stop an unverified process."
    }
    return
  }

  $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($pidValue -notmatch '^\d+$') {
    throw "Viewer pid file is invalid: $pidFile"
  }

  $processId = [int]$pidValue
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    return
  }
  if ($process.ProcessName -ne "node") {
    throw "PID $processId belongs to $($process.ProcessName), not Node.js. Refusing to stop it."
  }

  $ownedListeners = @(foreach ($port in @($viewerPort, $ingestPort)) {
    Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $processId }
  })
  if ($ownedListeners.Count -eq 0) {
    throw "PID $processId does not own the configured trace ports. Refusing to stop it."
  }

  Write-Host "Stopping existing viewer process $processId ($($process.ProcessName))."
  Stop-Process -Id $processId -Force -ErrorAction Stop
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

function Build-CodexTraceWrapperFromSource {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )

  $buildScript = Join-Path $SourceRoot "codex-trace-wrapper\scripts\build-release.ps1"
  $wrapperMain = Join-Path $SourceRoot "codex-trace-wrapper\cmd\codex-trace-wrapper\main.go"
  if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf) -or -not (Test-Path -LiteralPath $wrapperMain -PathType Leaf)) {
    return $false
  }

  $goCommand = Get-Command go -ErrorAction SilentlyContinue
  if ($null -eq $goCommand) {
    throw "This is a source checkout and the wrapper has not been built. Install Go 1.22 or newer, reopen PowerShell, and rerun .\codex-trace.ps1 install."
  }

  Write-Host "Wrapper executable not found; building it from source with $($goCommand.Source)."
  & $buildScript
  if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "Wrapper build completed without creating: $OutputPath"
  }

  return $true
}

function Assert-CodexTraceNodeRuntime {
  param([Parameter(Mandatory = $true)][string]$SourceRoot)

  $bundledNode = Join-Path $SourceRoot "runtime\node.exe"
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    return
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw "Node.js 20 or newer is required to run the viewer. Install Node.js, reopen PowerShell, and rerun .\codex-trace.ps1 install."
  }

  $nodeVersion = (& $nodeCommand.Source --version).Trim()
  if ($nodeVersion -notmatch '^v(?<major>\d+)\.') {
    throw "Could not determine the Node.js version from: $nodeVersion"
  }
  if ([int]$Matches.major -lt 20) {
    throw "Node.js 20 or newer is required to run the viewer. Found $nodeVersion at $($nodeCommand.Source)."
  }
}

function Install-CodexTraceViewerDependencies {
  param([Parameter(Mandatory = $true)][string]$SourceRoot)

  $viewerRoot = Join-Path $SourceRoot "codex-trace-viewer"
  $dependencyPath = Join-Path $viewerRoot "node_modules\iconv-lite\package.json"
  if (Test-Path -LiteralPath $dependencyPath -PathType Leaf) {
    return
  }

  $packageLock = Join-Path $viewerRoot "package-lock.json"
  if (-not (Test-Path -LiteralPath $packageLock -PathType Leaf)) {
    throw "Viewer dependencies are missing and package-lock.json was not found: $packageLock"
  }

  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if ($null -eq $npmCommand) {
    throw "npm is required to install viewer dependencies from a source checkout. Install Node.js 20 or newer, reopen PowerShell, and rerun .\codex-trace.ps1 install."
  }

  Write-Host "Installing locked viewer production dependencies."
  Push-Location $viewerRoot
  try {
    & $npmCommand.Source ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $dependencyPath -PathType Leaf)) {
    throw "Viewer dependency installation completed without creating: $dependencyPath"
  }
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

$packageWrapper = Join-Path $SourceRoot "bin\codex-trace-wrapper.exe"
$packageConfig = Join-Path $SourceRoot "bin\config.toml"
$sourceBuildWrapper = Join-Path $SourceRoot "codex-trace-wrapper\dist\codex-trace-wrapper.exe"
$sourceConfig = Join-Path $SourceRoot "codex-trace-wrapper\config.toml"
$releaseConfig = Join-Path $SourceRoot "tools\release-config.toml"
$wrapperSource = $null
if (Test-Path -Path $packageWrapper -PathType Leaf) {
  $wrapperSource = $packageWrapper
} elseif (Test-Path -Path $sourceBuildWrapper -PathType Leaf) {
  $wrapperSource = $sourceBuildWrapper
} elseif (Build-CodexTraceWrapperFromSource -SourceRoot $SourceRoot -OutputPath $sourceBuildWrapper) {
  $wrapperSource = $sourceBuildWrapper
} else {
  throw "Wrapper executable not found. Expected bin\codex-trace-wrapper.exe in a release package, or codex-trace-wrapper\dist\codex-trace-wrapper.exe in a source checkout. Build the wrapper first."
}
$configSource = $null
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
  $resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    throw "Explicit wrapper config is not a file: $resolvedConfigPath"
  }
  $configSource = $resolvedConfigPath
} elseif (Test-Path -Path $packageConfig -PathType Leaf) {
  $configSource = $packageConfig
} elseif (Test-Path -Path $releaseConfig -PathType Leaf) {
  $configSource = $releaseConfig
} elseif (Test-Path -Path $sourceConfig -PathType Leaf) {
  $configSource = $sourceConfig
} else {
  throw "Wrapper config not found. Expected bin\config.toml in a release package, or codex-trace-wrapper\config.toml in a source checkout."
}

if (-not $NoStartViewer) {
  Assert-CodexTraceNodeRuntime -SourceRoot $SourceRoot
}

Install-CodexTraceViewerDependencies -SourceRoot $SourceRoot

if (-not $NoStartViewer) {
  Stop-CodexTraceViewer -Root $InstallRoot
}

$sameRoot = [string]::Equals($SourceRoot.TrimEnd('\'), $InstallRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
if (-not $sameRoot) {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if (Test-Path -Path (Join-Path $SourceRoot "bin") -PathType Container) {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "bin") | Out-Null
    Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination (Join-Path $InstallRoot "bin\codex-trace-wrapper.exe") -Label "wrapper executable"
  } else {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "bin") | Out-Null
    Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination (Join-Path $InstallRoot "bin\codex-trace-wrapper.exe") -Label "wrapper executable"
  }
  Copy-CodexTraceDirectory -Source (Join-Path $SourceRoot "codex-trace-viewer") -Destination (Join-Path $InstallRoot "codex-trace-viewer") -PreserveTopLevelNames @("logs")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace-wrapper") -Destination (Join-Path $InstallRoot "codex-trace-wrapper")
  Copy-CodexTraceFileIfChanged -Source $configSource -Destination (Join-Path $InstallRoot "bin\config.toml") -Label "wrapper config"
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "scripts") -Destination (Join-Path $InstallRoot "scripts")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "docs") -Destination (Join-Path $InstallRoot "docs")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "README.md") -Destination (Join-Path $InstallRoot "README.md")
  if (Test-Path -LiteralPath (Join-Path $SourceRoot "LICENSE") -PathType Leaf) {
    Copy-CodexTraceItem -Source (Join-Path $SourceRoot "LICENSE") -Destination (Join-Path $InstallRoot "LICENSE")
  }
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "install.ps1") -Destination (Join-Path $InstallRoot "install.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace.ps1") -Destination (Join-Path $InstallRoot "codex-trace.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "start.ps1") -Destination (Join-Path $InstallRoot "start.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "stop.ps1") -Destination (Join-Path $InstallRoot "stop.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "status.ps1") -Destination (Join-Path $InstallRoot "status.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "enable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "enable-desktop-trace.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "disable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "disable-desktop-trace.ps1")
}

$wrapperPath = Join-Path $InstallRoot "bin\codex-trace-wrapper.exe"
$configPath = Join-Path $InstallRoot "bin\config.toml"
$traceScript = Join-Path $InstallRoot "codex-trace.ps1"
$enableScript = Join-Path $InstallRoot "scripts\enable-desktop-trace.ps1"

if (-not (Test-Path -Path $wrapperPath -PathType Leaf)) {
  Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination $wrapperPath -Label "wrapper executable"
}
Copy-CodexTraceFileIfChanged -Source $configSource -Destination $configPath -Label "wrapper config"
if (-not (Test-Path -Path $traceScript -PathType Leaf)) {
  throw "Main entry script not installed: $traceScript"
}

if (-not $NoEnable) {
  & $enableScript -InstallRoot $InstallRoot
}

if (-not $NoStartViewer) {
  & $traceScript start -InstallRoot $InstallRoot
}

Write-Host ""
Write-Host "Codex Trace installed at: $InstallRoot"
if ($NoStartViewer) {
  Write-Host "Viewer start skipped."
} else {
  Write-Host "Viewer URL: http://127.0.0.1:45123/?v=chat-redesign"
}
if (-not $NoEnable) {
  Write-Host "Restart Codex Desktop after first install or after re-enabling trace."
}
